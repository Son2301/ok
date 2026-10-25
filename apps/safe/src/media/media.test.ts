import { describe, expect, it } from 'vitest';
import { strictFetch } from '../test/helpers';
import {
  buildJpeg,
  buildMp3,
  buildMp4,
  buildPng,
  buildTiff,
  buildWebp,
  bytes,
  c2paStore,
  TAG,
} from '../test/media-fixtures';
import { combineSignals } from '../verdict/scoring';
import { summarizeC2pa } from './c2pa';
import { decodeCbor, encodeCbor } from './cbor';
import { parseContainer, sniff } from './containers';
import {
  hiveDetector,
  parseHiveResponse,
  parseRealityDefenderResult,
  parseSightengineResponse,
  realityDefenderDetector,
  sightengineDetector,
} from './detectors';
import { analyzeMedia } from './forensics';

const ids = (b: Uint8Array) => analyzeMedia(b).signals.map((s) => s.id);
const AI_DST = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

describe('CBOR', () => {
  it('round-trips maps, arrays, strings, ints and bytes', () => {
    const v = {
      claim_generator: 'Adobe_Firefly c2pa-rs/0.31',
      n: 300,
      neg: -5,
      list: [1, 'a', true, null],
      b: new Uint8Array([1, 2]),
    };
    expect(decodeCbor(encodeCbor(v))).toEqual(v);
  });
  it('rejects truncated input', () => {
    expect(() => decodeCbor(new Uint8Array([0x63, 0x61]))).toThrow();
  });
});

describe('container sniffing', () => {
  it('identifies formats by magic bytes', () => {
    expect(sniff(buildJpeg())?.format).toBe('jpeg');
    expect(sniff(buildPng())?.format).toBe('png');
    expect(sniff(buildWebp({ width: 10, height: 10 }))?.format).toBe('webp');
    expect(sniff(buildMp4({}))?.kind).toBe('video');
    expect(sniff(buildMp3({ TIT2: 'x' }))?.kind).toBe('audio');
    expect(sniff(bytes('hello world'))).toBeNull();
  });
});

describe('EXIF / XMP / IPTC in JPEG', () => {
  it('reads camera EXIF and treats it as weak trust evidence', () => {
    const jpg = buildJpeg({
      tiff: buildTiff(
        { [TAG.make]: 'Apple', [TAG.model]: 'iPhone 15 Pro' },
        { [TAG.dateTimeOriginal]: '2025:10:20 08:15:00' },
      ),
      width: 4032,
      height: 3024,
    });
    const m = parseContainer(jpg)!;
    expect(m.exif).toMatchObject({
      make: 'Apple',
      model: 'iPhone 15 Pro',
      dateTimeOriginal: '2025:10:20 08:15:00',
    });
    expect(m.width).toBe(4032);
    const f = analyzeMedia(jpg);
    expect(f.signals.map((s) => s.id)).toContain('media.camera_metadata');
    expect(combineSignals(f.signals).score).toBe(0);
  });

  it('flags editing software and AI face apps in EXIF Software', () => {
    expect(
      ids(buildJpeg({ tiff: buildTiff({ [TAG.software]: 'Adobe Photoshop 25.0 (Windows)' }) })),
    ).toContain('media.edited');
    expect(ids(buildJpeg({ tiff: buildTiff({ [TAG.software]: 'FaceApp' }) }))).toContain('media.ai_face_app');
  });

  it('detects AI generator names in EXIF/XMP and IPTC trainedAlgorithmicMedia', () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Midjourney v6" Iptc4xmpExt:DigitalSourceType="${AI_DST}"/></rdf:RDF></x:xmpmeta>`;
    const f = analyzeMedia(buildJpeg({ xmp, width: 1024, height: 1024 }));
    expect(f.xmp?.creatorTool).toBe('Midjourney v6');
    expect(f.signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['media.iptc_ai_generated', 'media.generator_dimensions']),
    );
    expect(f.aiMarkers.map((m) => m.tool)).toContain('Midjourney');
    expect(combineSignals(f.signals).score).toBeGreaterThanOrEqual(80);

    const sw = analyzeMedia(buildJpeg({ tiff: buildTiff({ [TAG.software]: 'DALL·E 3' }) }));
    expect(sw.signals.map((s) => s.id)).toContain('media.ai_tool_marker');
  });

  it('reads IPTC-IIM from Photoshop APP13', () => {
    const m = parseContainer(buildJpeg({ iptc: { 80: 'Nguyen Van A', 110: 'Made with Google AI' } }))!;
    expect(m.iptc).toMatchObject({ byline: 'Nguyen Van A', credit: 'Made with Google AI' });
    expect(analyzeMedia(buildJpeg({ iptc: { 110: 'Made with Google AI' } })).aiMarkers[0]?.tool).toBe(
      'Google Imagen / Gemini',
    );
  });

  it('reports stripped files (no metadata) as insufficient data', () => {
    const f = analyzeMedia(buildJpeg({ width: 1280, height: 960 }));
    expect(f.insufficientData).toBe(true);
    expect(f.signals.map((s) => s.id)).toEqual(['media.no_camera_metadata']);
  });
});

describe('C2PA / Content Credentials', () => {
  it('parses a manifest from JPEG APP11: generator, AI source type, signer hint', () => {
    const store = c2paStore({
      claimGenerator: 'Adobe_Firefly c2pa-rs/0.31.0',
      actions: [{ action: 'c2pa.created', digitalSourceType: AI_DST, softwareAgent: 'Adobe Firefly' }],
      signerOrg: 'Adobe Inc.',
    });
    const s = summarizeC2pa(store);
    expect(s).toMatchObject({
      present: true,
      manifestCount: 1,
      claimGenerator: 'Adobe_Firefly c2pa-rs/0.31.0',
      actions: ['c2pa.created'],
      digitalSourceTypes: [AI_DST],
      softwareAgents: ['Adobe Firefly'],
      signerHints: ['Adobe Inc.'],
    });
    const f = analyzeMedia(buildJpeg({ jumbf: store }));
    expect(f.c2pa?.claimGenerator).toContain('Firefly');
    expect(f.signals.map((s) => s.id)).toContain('media.c2pa_ai_generated');
    expect(combineSignals(f.signals).score).toBeGreaterThanOrEqual(85);
  });

  it('reads v2 claim_generator_info and composite (AI-edited) source types from PNG caBX', () => {
    const store = c2paStore({
      claimGeneratorInfo: [{ name: 'Adobe Photoshop', version: '26.0' }],
      actions: [
        {
          action: 'c2pa.edited',
          digitalSourceType:
            'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
        },
      ],
    });
    const f = analyzeMedia(buildPng({ jumbf: store }));
    expect(f.c2pa?.claimGeneratorInfo).toEqual(['Adobe Photoshop 26.0']);
    expect(f.signals.map((s) => s.id)).toContain('media.c2pa_ai_edited');
  });

  it('reports presence only when the manifest has no AI claims', () => {
    const f = analyzeMedia(
      buildWebp({ width: 640, height: 480, jumbf: c2paStore({ claimGenerator: 'SomeApp/1.0' }) }),
    );
    expect(f.signals.find((s) => s.id === 'media.c2pa_present')?.weight).toBe(0);
  });

  it('finds C2PA in MP4 uuid boxes and survives garbage', () => {
    const f = analyzeMedia(
      buildMp4({
        jumbf: c2paStore({
          claimGenerator: 'OpenAI Sora',
          actions: [{ action: 'c2pa.created', digitalSourceType: AI_DST }],
        }),
      }),
    );
    expect(f.meta?.kind).toBe('video');
    expect(f.signals.map((s) => s.id)).toContain('media.c2pa_ai_generated');
    expect(summarizeC2pa(bytes([0, 0, 0, 12], 'jumb', [1, 2, 3, 4])).present).toBe(true);
    expect(() => summarizeC2pa(new Uint8Array([0xff, 0xff, 0xff]))).not.toThrow();
  });
});

describe('PNG text chunks', () => {
  it('detects Stable Diffusion parameters in tEXt', () => {
    const f = analyzeMedia(
      buildPng({
        width: 832,
        height: 1216,
        text: {
          parameters:
            'a portrait photo\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 832x1216, Model: sd_xl_base_1.0',
        },
      }),
    );
    expect(f.signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['media.generation_parameters', 'media.generator_dimensions']),
    );
    expect(f.aiMarkers.map((m) => m.tool)).toContain('Stable Diffusion');
  });

  it('detects ComfyUI workflows (compressed zTXt too) and XMP in iTXt', () => {
    expect(ids(buildPng({ ztxt: { workflow: '{"nodes":[{"type":"KSampler"}]}' } }))).toContain(
      'media.generation_parameters',
    );
    const f = analyzeMedia(
      buildPng({
        xmp: `<x:xmpmeta><rdf:Description Iptc4xmpExt:DigitalSourceType="${AI_DST}"/></x:xmpmeta>`,
      }),
    );
    expect(f.signals.map((s) => s.id)).toContain('media.iptc_ai_generated');
  });
});

describe('audio/video metadata', () => {
  it('reads ID3 frames and spots AI voice tools', () => {
    const f = analyzeMedia(buildMp3({ TSSE: 'ElevenLabs v2', TIT2: 'Voice message' }));
    expect(f.meta?.text['ID3.TSSE']).toBe('ElevenLabs v2');
    expect(f.aiMarkers.map((m) => m.tool)).toContain('ElevenLabs');
  });
  it('reads MP4 encoder atoms', () => {
    const f = analyzeMedia(buildMp4({ encoder: 'Runway Gen-3' }));
    expect(f.meta?.text['©too']).toBe('Runway Gen-3');
    expect(f.aiMarkers.map((m) => m.tool)).toContain('Runway');
  });
});

describe('external detector adapters (fixtures, unverified)', () => {
  const input = { bytes: buildJpeg(), mime: 'image/jpeg', filename: 'a.jpg', kind: 'image' as const };

  it('parses Hive responses', async () => {
    const fixture = {
      status: [
        {
          status: { code: '0' },
          response: {
            output: [
              {
                classes: [
                  { class: 'ai_generated', score: 0.97 },
                  { class: 'not_ai_generated', score: 0.03 },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(parseHiveResponse(fixture)).toMatchObject({ status: 'ok', aiProbability: 0.97, verified: false });
    const fetchFn = strictFetch({
      'https://api.thehive.ai/': async (req) => {
        expect(req.headers.get('authorization')).toBe('Token hive-key');
        return Response.json(fixture);
      },
    });
    expect((await hiveDetector('hive-key', fetchFn).detect(input)).aiProbability).toBe(0.97);
  });

  it('parses Sightengine image and video responses', async () => {
    expect(
      parseSightengineResponse({ status: 'success', type: { ai_generated: 0.12, deepfake: 0.02 } })
        .aiProbability,
    ).toBe(0.12);
    expect(
      parseSightengineResponse({
        status: 'success',
        data: { frames: [{ type: { ai_generated: 0.4 } }, { type: { ai_generated: 0.91 } }] },
      }).aiProbability,
    ).toBe(0.91);
    expect(parseSightengineResponse({ status: 'failure', error: { message: 'bad key' } }).status).toBe(
      'error',
    );
    const fetchFn = strictFetch({
      'https://api.sightengine.com/1.0/check.json': async (req) => {
        const form = await req.formData();
        expect(form.get('models')).toBe('genai,deepfake');
        expect(form.get('api_user')).toBe('u');
        return Response.json({ status: 'success', type: { ai_generated: 0.88 } });
      },
    });
    expect((await sightengineDetector('u', 's', fetchFn).detect(input)).aiProbability).toBe(0.88);
  });

  it('runs the Reality Defender presign → upload → poll flow', async () => {
    let polls = 0;
    const fetchFn = strictFetch({
      'https://rd.test/api/files/aws-presigned': () =>
        Response.json({ response: { signedUrl: 'https://upload.test/put' }, requestId: 'req-1' }),
      'https://upload.test/put': (req) => {
        expect(req.method).toBe('PUT');
        return new Response(null, { status: 200 });
      },
      'https://rd.test/api/media/users/req-1': () =>
        Response.json(
          ++polls < 2
            ? { resultsSummary: { status: 'ANALYZING' } }
            : { resultsSummary: { status: 'FAKE', metadata: { finalScore: 93 } } },
        ),
    });
    const d = realityDefenderDetector('rd-key', fetchFn, {
      maxWaitMs: 10_000,
      pollMs: 1,
      sleep: async () => {},
      baseUrl: 'https://rd.test',
    });
    expect(await d.detect(input)).toMatchObject({ status: 'ok', aiProbability: 0.93, detail: 'FAKE' });
    expect(
      parseRealityDefenderResult({ resultsSummary: { status: 'AUTHENTIC', metadata: { finalScore: null } } })
        ?.aiProbability,
    ).toBe(0.1);
    expect(parseRealityDefenderResult({ overallStatus: 'PROCESSING' })).toBeNull();
  });

  it('turns detector errors into status "error"', async () => {
    const fetchFn = strictFetch({ 'https://api.thehive.ai/': () => new Response('nope', { status: 401 }) });
    expect(await hiveDetector('k', fetchFn).detect(input)).toMatchObject({
      status: 'error',
      detail: 'HTTP 401',
    });
  });
});
