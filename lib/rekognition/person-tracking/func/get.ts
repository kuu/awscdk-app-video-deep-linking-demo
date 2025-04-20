import { RekognitionClient, GetPersonTrackingCommand, PersonDetection, S3Object, VideoMetadata } from '@aws-sdk/client-rekognition';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const client = new RekognitionClient({
  region: process.env.REGION,
});

const s3Client = new S3Client({
  region: process.env.REGION,
  endpoint: `https://s3.${process.env.REGION}.amazonaws.com`,
});

const OUTPUT_BUCKET_NAME = process.env.OUTPUT_BUCKET_NAME as string;

export async function handler(event: any) {
  console.log(`Event: ${JSON.stringify(event)}`);
  const messages = event.Messages;

  if (!messages || messages.length === 0) {
    console.error('Empty message');
    return {};
  }

  const message = messages[0]

  if (!message || !message?.JobId) {
    console.error('JobId is not defined');
    return {};
  }

  const {persons, s3Object, videoMetadata} = await getPersons(message.JobId)

  const input = {
    s3Object,
    videoMetadata,
  };

  const outputFileName = `${message.Video.S3ObjectName}.persons.json`;
  const output = {
    s3Object: {
      Bucket: OUTPUT_BUCKET_NAME,
      Name: outputFileName,
    },
  };

  await s3Client.send(new PutObjectCommand({
    Bucket: OUTPUT_BUCKET_NAME,
    Key: outputFileName,
    Body: JSON.stringify(persons, null, 2),
  }));

  console.log(`Persons are saved to s3://${OUTPUT_BUCKET_NAME}/${outputFileName}`);

  return { input, output };
}

async function getPersons(jobId: string): Promise<{
  persons: PersonDetection[],
  s3Object: S3Object | undefined,
  videoMetadata: VideoMetadata | undefined,
}> {
  let persons: PersonDetection[] = [];
  let s3Object: S3Object | undefined;
  let videoMetadata: VideoMetadata | undefined;
  let nextToken: string | undefined;

  do {
    const command = new GetPersonTrackingCommand({
      JobId: jobId,
      NextToken: nextToken,
    });
    const response = await client.send(command);
    if (!response || !response?.Persons) {
      break;
    }
    persons = [...persons, ...response.Persons];
    s3Object ??= response.Video?.S3Object;
    videoMetadata ??= response.VideoMetadata;
    nextToken = response.NextToken;
  } while (nextToken);
  return {persons, s3Object, videoMetadata};
}