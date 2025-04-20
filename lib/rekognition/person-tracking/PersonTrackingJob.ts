import { Duration } from 'aws-cdk-lib';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Pass, Wait, WaitTime, Chain, Choice, Condition, IChainable } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Lambda } from './Lambda';

export interface PersonTrackingJobProps {
  readonly inputBucket: IBucket; // S3 bucket that stores the video file
  readonly outputBucket: IBucket; // S3 bucket that stores the output files
}

export class PersonTrackingJob extends Construct {
  public readonly job: IChainable;

  constructor(scope: Construct, id: string, {
    inputBucket,
    outputBucket,
  }: PersonTrackingJobProps) {
    super(scope, id);

    // Create SNS topic
    const personTrackingComplete = new Topic(this, 'AmazonRekognitionPersonTrackingComplete', {
      topicName: 'AmazonRekognitionPersonTrackingComplete',
    });

    // Create SQS queue
    const queue = new Queue(this, 'PersonTrackingQueue', {
      visibilityTimeout: Duration.seconds(300),
    });

    // Subscribe to the SNS topic
    personTrackingComplete.addSubscription(new SqsSubscription(queue));

    // Create Lambda function to call Amazon Rekognition API
    const rekognitionLambda = new Lambda(this, 'PersonTrackingLambda', {
      inputBucket,
      outputBucket,
      topicArn: personTrackingComplete.topicArn,
      sqsQueueUrl: queue.queueUrl,
    });

    // Start person tracking
    const rekognitionStart = new LambdaInvoke(this, 'Invoke StartPersonTracking API', {
      lambdaFunction: rekognitionLambda.startFunc,
      inputPath: '$.Payload',
    });

    // Monitor SQS queue
    const monitorQueue = new LambdaInvoke(this, 'Monitor SQS for person tracking', {
      lambdaFunction: rekognitionLambda.pollFunc,
      inputPath: '$.Payload',
    });

    // Get person tracking results
    const rekognitionGet = new LambdaInvoke(this, 'Invoke GetPersonTracking API', {
      lambdaFunction: rekognitionLambda.getFunc,
      inputPath: '$.Payload',
    });

    // Sleep for 5 seconds
    const rekognitionWait = new Wait(this, 'Wait for person tracking', {
      time: WaitTime.duration(Duration.seconds(5)),
    });

    this.job = Chain.start(
      new Pass(this, 'Start person tracking Job', { inputPath: '$', resultPath: '$.Payload' }),
    )
      .next(rekognitionStart)
      .next(rekognitionWait)
      .next(monitorQueue)
      .next(
        new Choice(this, 'Check if person tracking is completed')
          .when(Condition.numberGreaterThan('$.Payload.MessageCount', 0), rekognitionGet)
          .otherwise(rekognitionWait),
      );
  }
}