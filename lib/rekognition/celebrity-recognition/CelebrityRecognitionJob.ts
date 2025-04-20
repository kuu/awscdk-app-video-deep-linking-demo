import { Duration } from 'aws-cdk-lib';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Pass, Wait, WaitTime, Chain, Choice, Condition, IChainable } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Lambda } from './Lambda';

export interface CelebrityRecognitionJobProps {
  readonly inputBucket: IBucket; // S3 bucket that stores the video file
  readonly outputBucket: IBucket; // S3 bucket that stores the output files
}

export class CelebrityRecognitionJob extends Construct {
  public readonly job: IChainable;

  constructor(scope: Construct, id: string, {
    inputBucket,
    outputBucket,
  }: CelebrityRecognitionJobProps) {
    super(scope, id);

    // Create SNS topic
    const celebrityRecognitionComplete = new Topic(this, 'AmazonRekognitionCelebrityRecognitionComplete', {
      topicName: 'AmazonRekognitionCelebrityRecognitionComplete',
    });

    // Create SQS queue
    const queue = new Queue(this, 'CelebrityRecognitionQueue', {
      visibilityTimeout: Duration.seconds(300),
    });

    // Subscribe to the SNS topic
    celebrityRecognitionComplete.addSubscription(new SqsSubscription(queue));

    // Create Lambda function to call Amazon Rekognition API
    const rekognitionLambda = new Lambda(this, 'CelebrityRecognitionLambda', {
      inputBucket,
      outputBucket,
      topicArn: celebrityRecognitionComplete.topicArn,
      sqsQueueUrl: queue.queueUrl,
    });

    // Start celebrity recognition
    const rekognitionStart = new LambdaInvoke(this, 'Invoke StartCelebrityRecognition API', {
      lambdaFunction: rekognitionLambda.startFunc,
      inputPath: '$.Payload',
    });

    // Monitor SQS queue
    const monitorQueue = new LambdaInvoke(this, 'Monitor SQS for celebrity recognition', {
      lambdaFunction: rekognitionLambda.pollFunc,
      inputPath: '$.Payload',
    });

    // Get celebrity recognition results
    const rekognitionGet = new LambdaInvoke(this, 'Invoke GetCelebrityRecognition API', {
      lambdaFunction: rekognitionLambda.getFunc,
      inputPath: '$.Payload',
    });

    // Sleep for 5 seconds
    const rekognitionWait = new Wait(this, 'Wait for celebrity recognition', {
      time: WaitTime.duration(Duration.seconds(5)),
    });

    this.job = Chain.start(
      new Pass(this, 'Start Celebrity Recognition Job', { inputPath: '$', resultPath: '$.Payload' }),
    )
      .next(rekognitionStart)
      .next(rekognitionWait)
      .next(monitorQueue)
      .next(
        new Choice(this, 'Check if celebrity recognition is completed')
          .when(Condition.numberGreaterThan('$.Payload.MessageCount', 0), rekognitionGet)
          .otherwise(rekognitionWait),
      );
  }
}