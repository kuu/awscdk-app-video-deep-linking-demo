import * as crypto from 'crypto';
import { Aws, Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Distribution, OriginAccessIdentity, ViewerProtocolPolicy, AllowedMethods, CachedMethods, CachePolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Rule, RuleTargetInput, EventField } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { Role, PolicyStatement, ManagedPolicy, ServicePrincipal, CanonicalUserPrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { StateMachine, Chain, DefinitionBody, Parallel, IChainable, JsonPath } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke, MediaConvertCreateJob } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Lambda } from './Lambda';
// import { LabelDetectionJob } from './rekognition/label-detection/LabelDetectionJob';
// import { CelebrityRecognitionJob } from './rekognition/celebrity-recognition/CelebrityRecognitionJob';
import { PersonTrackingJob } from './rekognition/person-tracking/PersonTrackingJob';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    // Create S3 bucket for input files
    const inputBucketName = `${crypto.randomUUID()}`;
    const inputBucket = new Bucket(this, inputBucketName, {
      bucketName: inputBucketName,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      eventBridgeEnabled: true, // To let S3 send event notifications to EventBridge
    });

    // Create S3 bucket for output files
    const outputBucketName = `${crypto.randomUUID()}`;
    const outputBucket = new Bucket(this, outputBucketName, {
      bucketName: outputBucketName,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create Amazon Rekognition Job
    /* const labelDetection = new LabelDetectionJob(this, 'LabelDetectionJob', {
      inputBucket,
      outputBucket,
    });
    const personTracking = new PersonTrackingJob(this, 'PersonTrackingJob', {
      inputBucket,
      outputBucket,
    }); */
    const personTracking = new PersonTrackingJob(this, 'PersonTrackingJob', {
      inputBucket,
      outputBucket,
    });

    // Create Lambda function to generate the VTT file
    const vttGenerationLambda = new Lambda(this, 'VttLambda', {
      bucket: outputBucket,
    });

    // Create VTT file generation job
    const vttGeneration = new LambdaInvoke(this, 'Generate VTT and HTML files', {
      lambdaFunction: vttGenerationLambda.func,
      inputPath: '$.Payload',
    });

    // Create MediaConvert transcoding job
    const mediaConvertJob = this.createMediaConvertJob(
      inputBucket,
      outputBucket,
      '$.s3Object.key',
      'HLS Transcoding',
    );

    // Create a state machine that runs all jobs
    const stateMachine = new StateMachine(this, 'StateMachine', {
      definitionBody: DefinitionBody.fromChainable(
        Chain.start(
          new Parallel(this, 'Run video transcoding and analysis jobs', {
            resultSelector: {
              input: {
                'videoS3Object.$': '$[1].Payload.input.s3Object',
                'videoMetadata.$': '$[1].Payload.input.videoMetadata',
              },
              output: {
                'rekognitionS3Object.$': '$[1].Payload.output.s3Object',
              },
            },
            resultPath: '$.Payload',
          })
            .branch(mediaConvertJob)
            .branch(personTracking.job)
        )
        .next(vttGeneration)
      ),
    });

    // Create CloudFront distribution to serve the HLS video
    const distribution = this.createCloudFrontDistribution(outputBucket);
    const htmlUrl = `https://${distribution.distributionDomainName}/{Source MP4 file name}.html`;

    // Create an EventBridge rule to receive S3 event notifications
    const rule = new Rule(this, 'S3EventRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        resources: [inputBucket.bucketArn],
      },
      targets: [
        new SfnStateMachine(stateMachine, {
          input: RuleTargetInput.fromObject({
            s3Object: {
              time: EventField.time,
              key: EventField.fromPath('$.detail.object.key'),
            },
          }),
        }),
      ],
    });

    // Print the EventBridge rule name
    new CfnOutput(this, 'EventBridgeRuleName', {
      value: rule.ruleName,
      exportName: Aws.STACK_NAME + 'EventBridgeRuleName',
      description: 'EventBridge rule name',
    });

    // Print the HTML URL
    new CfnOutput(this, 'HtmlUrl', {
      value: htmlUrl,
      exportName: Aws.STACK_NAME + 'HtmlUrl',
      description: 'HTML URL for testing',
    });

    // Print the S3 bucket URL
    new CfnOutput(this, 'InputBucket', {
      value: `s3://${inputBucketName}/`,
      exportName: Aws.STACK_NAME + 'InputBucket',
      description: 'S3 bucket for input files',
    });

    // Print the S3 bucket URL
    new CfnOutput(this, 'OutputBucket', {
      value: `s3://${outputBucketName}/`,
      exportName: Aws.STACK_NAME + 'OutputBucket',
      description: 'S3 bucket for output files',
    });
  }

  createMediaConvertJob(
    inputBucket: IBucket,
    outputBucket: IBucket,
    videoPath: string,
    id: string,
  ): IChainable {
    //Create an IAM Role that gives Amazon Transcribe S3 access permissions
    const role = new Role(this, `IamRoleForMediaConvert-${id}`, {
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonAPIGatewayInvokeFullAccess'),
      ],
      assumedBy: new ServicePrincipal('mediaconvert.amazonaws.com'),
    });
    const roleArn = role.roleArn;
    return new MediaConvertCreateJob(this, `Run MediaConvert Job - ${id}`, {
      createJobRequest: {
        Role: roleArn,
        Settings: {
          Inputs: [
            {
              'FileInput': JsonPath.format(`s3://${inputBucket.bucketName}/{}`, JsonPath.stringAt(videoPath)),
              'VideoSelector': {},
              'AudioSelectors': {
                'Audio Selector 1': {
                  DefaultSelection: 'DEFAULT',
                },
              },
              'TimecodeSource': 'ZEROBASED',
            },
          ],
          OutputGroups: [
            {
              Name: 'Apple HLS',
              OutputGroupSettings: {
                Type: 'HLS_GROUP_SETTINGS',
                HlsGroupSettings: {
                  SegmentLength: 6,
                  Destination: JsonPath.format(`s3://${outputBucket.bucketName}/hls/{}`, JsonPath.arrayGetItem(JsonPath.stringSplit(JsonPath.stringAt(videoPath), '.'), 0)),
                  MinSegmentLength: 0,
                },
              },
              Outputs: [
                {
                  ContainerSettings: {
                    Container: 'M3U8',
                    M3u8Settings: {},
                  },
                  VideoDescription: {
                    CodecSettings: {
                      Codec: 'H_264',
                      H264Settings: {
                        MaxBitrate: 1500000,
                        RateControlMode: 'QVBR',
                        SceneChangeDetect: 'TRANSITION_DETECTION',
                      },
                    },
                  },
                  AudioDescriptions: [
                    {
                      AudioSourceName: 'Audio Selector 1',
                      CodecSettings: {
                        Codec: 'AAC',
                        AacSettings: {
                          Bitrate: 96000,
                          CodingMode: 'CODING_MODE_2_0',
                          SampleRate: 48000,
                        },
                      },
                    },
                  ],
                  OutputSettings: {
                    HlsSettings: {},
                  },
                  NameModifier: '_main',
                },
              ],
            },
          ],
          TimecodeConfig: {
            Source: 'ZEROBASED',
          },
          FollowSource: 1,
        },
        AccelerationSettings: {
          Mode: 'DISABLED',
        },
        StatusUpdateInterval: 'SECONDS_60',
        Priority: 0,
      },
      inputPath: '$',
    });
  }

  createCloudFrontDistribution(bucket: IBucket): Distribution {
    // Create an Origin Access Identity (OAI)
    const oai = new OriginAccessIdentity(this, 'OAI', {
      comment: 'OAI for CloudFront to access private S3 bucket',
    });

    // Grant the OAI access to the private S3 bucket
    bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${bucket.bucketArn}/*`],
        principals: [new CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
      }),
    );

    // Create a CloudFront distribution
    return new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: ViewerProtocolPolicy.ALLOW_ALL,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.ELEMENTAL_MEDIA_PACKAGE,
      },
      enabled: true,
    });
  }
}