import { deflateSync } from 'node:zlib';

// 투명 캔버스 브리지(video-generation-open §2-(b)/D-V5) — 1.5는 text-to-video
// 를 거부하므로, 소스 이미지가 없는 요청에는 완전 투명 PNG를 주입해 프롬프트
// 만으로 장면을 생성하게 한다(S0 실측: 첫 ~0.2초 페이드인 후 완전한 장면).
// 결정적 산출물이라 모듈 로드 시 1회만 인코딩한다.

const BLANK_CANVAS_WIDTH = 1280;
const BLANK_CANVAS_HEIGHT = 720;

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodeTransparentPng(width: number, height: number): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 스캔라인마다 필터 바이트 0 + 전부 0인 RGBA(=완전 투명)
  const raw = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLANK_CANVAS_DATA_URL = `data:image/png;base64,${encodeTransparentPng(
  BLANK_CANVAS_WIDTH,
  BLANK_CANVAS_HEIGHT,
).toString('base64')}`;

export function blankCanvasDataUrl(): string {
  return BLANK_CANVAS_DATA_URL;
}
