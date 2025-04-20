import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

const client = new SQSClient({
  region: process.env.REGION,
});

const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL as string;

export async function handler(event: any) {
  const jobId = event.JobId;
  const command = new ReceiveMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
  });
  const response = await client.send(command);
  try {
    const responseText = JSON.stringify(response, null, 2);
    console.log(responseText);
  } catch (e) {
    console.log(response);
    console.error(e);
  }
  const messages = response.Messages;
  let count = messages?.length ?? 0;
  console.log(`JobId: ${jobId}}, MessageCount: ${count}`);
  if (jobId && count > 0) {
    for (let i = 0; i < count; i++) {
      const messageBody = messages![i].Body;
      console.log(`Body: ${messageBody}`);
      if (messageBody) {
        try {
          const body = JSON.parse(messageBody);
          console.log(`Message: ${body.Message}`);
          const message = JSON.parse(body.Message);
          if (message?.JobId === jobId && message?.Status === 'SUCCEEDED') {
            console.log(`JobId ${jobId} is found}`);
            return { MessageCount: 1, Messages: [message]};
          }
        } catch (e) {
          console.error('Invalid message body');
        }
      }
    }
  }
  // console.log(JSON.stringify(response, null, 2));
  return { MessageCount: 0, Messages: [], JobId: jobId};
}
