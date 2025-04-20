import { Duration } from 'aws-cdk-lib';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Pass, Wait, WaitTime, Chain, Choice, Condition, IChainable } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Lambda } from './Lambda';

export interface LabelDetectionJobProps {
  readonly inputBucket: IBucket; // S3 bucket that stores the video file
  readonly outputBucket: IBucket; // S3 bucket that stores the output files
}

export class LabelDetectionJob extends Construct {
  public readonly job: IChainable;

  constructor(scope: Construct, id: string, {
    inputBucket,
    outputBucket,
  }: LabelDetectionJobProps) {
    super(scope, id);

    // Create SNS topic
    const labelDetectionComplete = new Topic(this, 'AmazonRekognitionLabelDetectionComplete', {
      topicName: 'AmazonRekognitionLabelDetectionComplete',
    });

    // Create SQS queue
    const queue = new Queue(this, 'LabelDetectionQueue', {
      visibilityTimeout: Duration.seconds(300),
    });

    // Subscribe to the SNS topic
    labelDetectionComplete.addSubscription(new SqsSubscription(queue));

    // Create Lambda function to call Amazon Rekognition API
    const rekognitionLambda = new Lambda(this, 'LabelDetectionLambda', {
      inputBucket,
      outputBucket,
      topicArn: labelDetectionComplete.topicArn,
      sqsQueueUrl: queue.queueUrl,
    });

    // Start label detection
    const rekognitionStart = new LambdaInvoke(this, 'Invoke StartLabelDetection API', {
      lambdaFunction: rekognitionLambda.startFunc,
      inputPath: '$.Payload',
    });

    // Monitor SQS queue
    const monitorQueue = new LambdaInvoke(this, 'Monitor SQS for Label', {
      lambdaFunction: rekognitionLambda.pollFunc,
      inputPath: '$.Payload',
    });

    // Get label detection results
    const rekognitionGet = new LambdaInvoke(this, 'Invoke GetLabelDetection API', {
      lambdaFunction: rekognitionLambda.getFunc,
      inputPath: '$.Payload',
    });

    // Sleep for 5 seconds
    const rekognitionWait = new Wait(this, 'Wait for label Detection', {
      time: WaitTime.duration(Duration.seconds(5)),
    });

    this.job = Chain.start(
      new Pass(this, 'Start Label Detection Job', { inputPath: '$', resultPath: '$.Payload' }),
    )
      .next(rekognitionStart)
      .next(rekognitionWait)
      .next(monitorQueue)
      .next(
        new Choice(this, 'Check if label Detection is completed')
          .when(Condition.numberGreaterThan('$.Payload.MessageCount', 0), rekognitionGet)
          .otherwise(rekognitionWait),
      );
  }
}