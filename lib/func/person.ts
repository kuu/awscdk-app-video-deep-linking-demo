import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PersonDetection, BoundingBox } from '@aws-sdk/client-rekognition';

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

  // Get the person tracking file name
  const personTrackingFileName = output?.rekognitionS3Object?.Name;
  if (!personTrackingFileName) {
    throw new Error('The personTrackingFileName is not specified');
  }

  // Download persons file
  const persons = await client.send(new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: personTrackingFileName,
  }));

  if (!persons || !persons?.Body) {
    console.error('The persons file is not found');
    return;
  }
  const personsStr = await persons.Body?.transformToString();
  if (!personsStr) {
    console.error('The persons file is empty');
    return;
  }

  // Format the persons file
  const personsArray: PersonDetection[] = JSON.parse(personsStr as string);
  const timedMetadata: Metadata[] = [];
  for (const person of personsArray) {
    if (person.Person?.Face?.BoundingBox) {
      const lastMetadata = timedMetadata.length > 0 ? timedMetadata[timedMetadata.length - 1] : undefined;
      if (!lastMetadata || lastMetadata.timestamp !== person.Timestamp) {
        timedMetadata.push({
          timestamp: person.Timestamp!,
          objects: [{
            id: `${person.Person.Index!}`,
            name: `Person-${person.Person.Index!}`,
            boxes: [person.Person.Face.BoundingBox!],
          }],
        });
      } else {
        lastMetadata.objects.push({
          id: `${person.Person.Index!}`,
          name: `Person-${person.Person.Index!}`,
          boxes: [person.Person.Face.BoundingBox!],
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
  <title>Video with WebVTT timed metadata</title>
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
    button {
      margin: 10px;
      padding: 10px 20px;
      font-size: 1em;
    }
    video:hover {
      transform: scale(1.05);
    }
    .overlay {
      display: none;
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
    .ctrl {
      display: none;
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
    .ctrl:hover {
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <video>
    <source src="${videoFilePath}" type="application/vnd.apple.mpegurl" />
    <track src="${vttFilePath}" kind="metadata" srclang="en" default />
    Your browser does not support the video tag.
  </video>
  <canvas class="overlay"></canvas>
  <div>
    <button id="play">Play</button>
  </div>
  <div class="ctrl"></div>
  <script>
    const video = document.querySelector('video');
    const playButton = document.querySelector('#play');
    const track = video.querySelector('track');
    const ctrl = document.querySelector('.ctrl');
    const canvas = document.querySelector('.overlay');
    const ctx = canvas.getContext('2d');
    const hashPrefix = '#:video:';

    function getReplayMode() {
      const replayMode = window.location.hash.startsWith(hashPrefix);
      if (replayMode) {
        const hash = window.location.hash.slice(hashPrefix.length);
        const parts = hash.split('=');
        const startTime = parseFloat(parts[0]);
        const ids = parts[1].split(',');
        return {replayMode, startTime, ids};
      }
      return {replayMode, startTime: 0, ids: []};
    }

    const {replayMode, startTime, ids} = getReplayMode();

    playButton.addEventListener('click', () => {
      if (video.paused) {
        video.play();
        playButton.textContent = 'Pause';
      } else {
        video.pause();
        playButton.textContent = 'Play';
      }
    });

    video.addEventListener('canplay', () => {
      video.currentTime = startTime;
    });

    video.addEventListener('play', () => {
      if (replayMode) {
        canvas.style.display = 'block';
        ctrl.style.display = 'none';
      } else {
        canvas.style.display = 'none';
        ctrl.style.display = 'none';
      }
    });
    video.addEventListener('pause', () => {
      if (!replayMode) {
        canvas.style.display = 'block';
        ctrl.style.display = 'block';
      }
    });
    video.addEventListener('ended', () => {
      if (!replayMode) {
        canvas.style.display = 'none';
        ctrl.style.display = 'none';
      }
    });

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
      ctrl.innerHTML = '';
  
      const cues = track.track.activeCues;
      if (!cues && cues.length === 0) {
        return;
      }
      const metadataList = JSON.parse(cues[0].text);
      const form = document.createElement('form');
      for (const metadata of metadataList) {
        const {name, boxes, id} = metadata;
        if (replayMode && !ids.includes(id)) {
          continue;
        }
        for (const box of boxes) {
          const x = box.Left * width;
          const y = box.Top * height;
          const w = box.Width * width;
          const h = box.Height * height;
          ctx.strokeRect(x, y, w, h);
          ctx.fillText(name, x, y - 4);
        }
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.addEventListener('change', (e) => {
          const checkedList = form.querySelectorAll('input[type="checkbox"]:checked');
          const button = form.querySelector('#copy-link');
          button.disabled = checkedList.length === 0;
        });
        const label = document.createElement('label');
        label.textContent = name;
        label.appendChild(input);
        const div = document.createElement('div');
        div.appendChild(label);
        form.appendChild(div);
      }
      const button = document.createElement('button');
      button.textContent = 'Copy Link';
      button.disabled = true;
      button.id = 'copy-link';
      const div = document.createElement('div');
      div.appendChild(button);
      form.appendChild(div);
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const checkedList = form.querySelectorAll('input[type="checkbox"]:checked');
        const ids = Array.from(checkedList).map(input => input.id);
        const url = window.location.href + hashPrefix + video.currentTime + '=' + ids.join(',');
        navigator.clipboard.writeText(url);
        console.log(url);
      });
      ctrl.appendChild(form);
    });
  </script>
</body>
</html>
`;
}