import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { CelebrityRecognition, BoundingBox } from '@aws-sdk/client-rekognition';

const client = new S3Client({
  region: process.env.REGION,
});

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME as string;

//import {readFileSync, writeFileSync} from 'fs';
//import {join} from 'path';

interface Metadata {
  readonly timestamp: number;
  readonly duration?: number;
  readonly objects: Object[];
}

interface Object {
  readonly id: string;
  readonly name: string;
  readonly boxes: BoundingBox[];
}

// Create WebVTT and HTML based on the results of the Rekognition jobs
export async function handler(event: any) {
  const { input, output } = event;

  // Get the video file name
  const sourceVideoFileName = input?.videoS3Object?.Name;
  if (!sourceVideoFileName) {
    throw new Error('The sourceVideoFileName is not specified');
  }

  // Get the video duration
  const videoMetadata = input?.videoMetadata;
  if (!videoMetadata?.DurationMillis) {
    throw new Error('videoMetadata.DurationMillis is not defined');
  }

  // Get the celebrity recognition file name
  const celebrityRecognitionFileName = output?.rekognitionS3Object?.Name;
  if (!celebrityRecognitionFileName) {
    throw new Error('The celebrityRecognitionFileName is not specified');
  }

  // Download celebrities file
  const celebrities = await client.send(new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: celebrityRecognitionFileName,
  }));

  if (!celebrities || !celebrities?.Body) {
    console.error('The celebrities file is not found');
    return;
  }
  const celebritiesStr = await celebrities.Body?.transformToString();
  if (!celebritiesStr) {
    console.error('The celebrities file is empty');
    return;
  }

  // Format the celebrities file
  const celebritiesArray: CelebrityRecognition[] = JSON.parse(celebritiesStr as string);
  const timedMetadata: Metadata[] = [];
  for (const celebrity of celebritiesArray) {
    if (celebrity.Celebrity?.Face?.BoundingBox) {
      const lastMetadata = timedMetadata.length > 0 ? timedMetadata[timedMetadata.length - 1] : undefined;
      if (!lastMetadata || lastMetadata.timestamp !== celebrity.Timestamp) {
        timedMetadata.push({
          timestamp: celebrity.Timestamp!,
          objects: [{
            id: celebrity.Celebrity.Id!,
            name: celebrity.Celebrity.Name!,
            boxes: [celebrity.Celebrity.Face.BoundingBox!],
          }],
        });
      } else {
        lastMetadata.objects.push({
          id: celebrity.Celebrity.Id!,
          name: celebrity.Celebrity.Name!,
          boxes: [celebrity.Celebrity.Face.BoundingBox!],
        });
      }
    }
  }

  // Generate and upload WebVTT file
  const vtt = createVtt(timedMetadata, videoMetadata.DurationMillis);
  const vttFileName = `${sourceVideoFileName.split('.')[0]}.vtt`;
  await client.send(new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: vttFileName,
    Body: vtt,
    ContentType: 'text/vtt; charset=UTF-8',
  }));
  console.log(`WebVTT file is uploaded to s3://${S3_BUCKET_NAME}/${vttFileName}`);

  // Generate and upload HTML file
  const html = createHtml(`./hls/${sourceVideoFileName.split('.')[0]}.m3u8`, `./${vttFileName}`);
  const htmlFileName = `${sourceVideoFileName.split('.')[0]}.html`;
  await client.send(new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: htmlFileName,
    Body: html,
    ContentType: 'text/html; charset=UTF-8',
  }));
  console.log(`HTML file is uploaded to s3://${S3_BUCKET_NAME}/${htmlFileName}`);

  return {
    video: sourceVideoFileName,
    vtt: vttFileName,
    html: htmlFileName,
  };
}

function createVtt(timedMetadata: Metadata[], duration: number): string {
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < timedMetadata.length; i++) {
    const {timestamp, objects} = timedMetadata[i];
    const startTime = getTimeStr(timestamp);
    const endTime = getTimeStr(getEndTime(timedMetadata, i, duration));
    lines.push(`${i}`);
    lines.push(`${startTime} --> ${endTime}`);
    lines.push(JSON.stringify(objects));
    lines.push('');
  }
  return lines.join('\n');
}

const MAX_DURATION_MS = 500;

function getEndTime(timedMetadata: Metadata[], index: number, videoEndTime: number): number {
  const metadata = timedMetadata[index];
  if (metadata.duration) {
    return metadata.timestamp + metadata.duration;
  }
  if (index === timedMetadata.length - 1) {
    return Math.min(videoEndTime, metadata.timestamp + MAX_DURATION_MS);
  }
  return Math.min(timedMetadata[index + 1].timestamp, metadata.timestamp + MAX_DURATION_MS);
}

function getTimeStr(timestamp: number | undefined): string {
  if (timestamp === undefined) {
    return 'undefined'; 
  }
  const hours = Math.floor(timestamp / 3600000);
  const minutes = Math.floor((timestamp % 3600000) / 60000);
  const seconds = (timestamp % 60000) / 1000;
  return `${hours.toFixed(0).padStart(2, '0')}:${minutes.toFixed(0).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`;
}

function createHtml(videoFilePath: string, vttFilePath: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Video with WebVTT</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: flex-start;
      height: 100vh;
      background-color: #f0f0f0;
    }
    video {
      width: 60%;
      height: auto;
      border: 2px solid #333;
      border-radius: 10px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      transition: transform 0.3s;
    }
    video:hover {
      transform: scale(1.05);
    }
    .overlay {
      position: absolute;
      background-color: rgba(0, 0, 0, 0.0);
      color: red;
      border: 2px solid #333;
      border-radius: 10px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      font-size: 0.6em;
      text-align: left;
      width: 60%;
      transition: opacity 0.3s;
    }
    .vtt {
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px;
      border-radius: 5px;
      font-size: 1.2em;
      text-align: left;
      width: 60%;
      max-width: 800px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      transition: opacity 0.3s;
    }
    .vtt:hover {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <video controls>
    <source src="${videoFilePath}" type="application/vnd.apple.mpegurl" />
    <track src="${vttFilePath}" kind="metadata" srclang="en" default />
    Your browser does not support the video tag.
  </video>
  <canvas class="overlay"></canvas>
  <div class="vtt">WebVTT Metadata</div>
  <script>
    const video = document.querySelector('video');
    const track = video.querySelector('track');
    const vtt = document.querySelector('.vtt');
    const canvas = document.querySelector('.overlay');
    const ctx = canvas.getContext('2d');

    track.addEventListener('cuechange', () => {

      ctx.beginPath();
      const width = video.clientWidth;
      const height = video.clientHeight;
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 4;
      ctx.fillStyle = 'red';
      ctx.font = "20px serif";

      const cues = track.track.activeCues;
      if (cues && cues.length > 0) {
        try {
          const metadataList = JSON.parse(cues[0].text);
          vtt.innerHTML = '';
          for (const metadata of metadataList) {
            const {name, boxes, id} = metadata;
            for (const box of boxes) {
              const x = box.Left * width;
              const y = box.Top * height;
              const w = box.Width * width;
              const h = box.Height * height;
              ctx.strokeRect(x, y, w, h);
              ctx.fillText(name, x, y - 4);
            }
            const div = document.createElement('div');
            const input = document.createElement('input');
            input.type = 'text';
            input.value = name;
            input.editable = false;
            const button = document.createElement('button');
            button.textContent = 'Copy Link';
            div.appendChild(input);
            div.appendChild(button);
            vtt.appendChild(div);
            button.addEventListener('click', () => {
              const url = window.location.href + '#:~:video:' + video.currentTime + '=' + id;
              navigator.clipboard.writeText(url);
              console.log(url);
            });
          }
          // vtt.innerHTML = JSON.stringify(metadataList, null, 2);
        } catch {
          vtt.innerHTML = '';
        }
      } else {
        vtt.innerHTML = '';
      }
    });
    video.addEventListener('play', () => {
      vtt.style.display = 'none';
      canvas.style.display = 'none';
    });
    video.addEventListener('pause', () => {
      vtt.style.display = 'block';
      canvas.style.display = 'block';
    });
    video.addEventListener('ended', () => {
      vtt.style.display = 'none';
      canvas.style.display = 'none';
    });
  </script>
</body>
</html>
`;
}