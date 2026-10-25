import { signal } from '../verdict/signal';
import type { Signal } from '../verdict/types';
import { type C2paSummary, summarizeC2pa } from './c2pa';
import { parseContainer, type RawMetadata } from './containers';

export interface XmpFields {
  creatorTool?: string;
  digitalSourceType?: string;
  credit?: string;
  softwareAgents: string[];
  make?: string;
  model?: string;
}

export interface MediaForensics {
  meta: RawMetadata | null;
  xmp?: XmpFields;
  c2pa?: C2paSummary;
  aiMarkers: { tool: string; where: string; value: string }[];
  signals: Signal[];
  /** Nothing useful left to judge from (stripped file, no metadata at all). */
  insufficientData: boolean;
}

function xmpValue(xml: string, name: string): string | undefined {
  const attr = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(xml)?.[1];
  if (attr) return attr.trim();
  const el = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1];
  if (!el) return undefined;
  const li = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(el)?.[1] ?? el;
  const v = li
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v || undefined;
}

export function parseXmp(xml: string): XmpFields {
  const agents = new Set<string>();
  for (const m of xml.matchAll(/softwareAgent\s*=\s*"([^"]+)"|<stEvt:softwareAgent>([^<]+)</gi))
    agents.add((m[1] ?? m[2])!.trim());
  return {
    creatorTool: xmpValue(xml, 'xmp:CreatorTool'),
    digitalSourceType:
      xmpValue(xml, 'Iptc4xmpExt:DigitalSourceType') ?? xmpValue(xml, 'plus:DigitalSourceType'),
    credit: xmpValue(xml, 'photoshop:Credit'),
    softwareAgents: [...agents].slice(0, 10),
    make: xmpValue(xml, 'tiff:Make'),
    model: xmpValue(xml, 'tiff:Model'),
  };
}

/** AI generators and the strings they leave in metadata. */
const AI_TOOLS: { tool: string; re: RegExp }[] = [
  { tool: 'Midjourney', re: /midjourney/i },
  { tool: 'DALL·E', re: /dall[\s·.\-_]?e/i },
  { tool: 'OpenAI / ChatGPT', re: /openai|chatgpt|gpt-image|gpt-4o/i },
  {
    tool: 'Stable Diffusion',
    re: /stable[\s_-]?diffusion|\bsdxl\b|sd_xl|automatic1111|\bsteps: ?\d+, ?sampler:/i,
  },
  { tool: 'ComfyUI', re: /comfyui|"class_type"\s*:/i },
  { tool: 'Adobe Firefly', re: /firefly/i },
  { tool: 'Google Imagen / Gemini', re: /\bimagen\b|made with google ai|\bgemini\b|google ai/i },
  { tool: 'NovelAI', re: /novelai/i },
  { tool: 'InvokeAI', re: /invokeai|sd-metadata/i },
  { tool: 'Leonardo.Ai', re: /leonardo\.ai/i },
  { tool: 'Ideogram', re: /ideogram/i },
  { tool: 'FLUX', re: /black forest labs|flux\.1|flux-(dev|schnell|pro)/i },
  { tool: 'Microsoft Designer / Bing Image Creator', re: /bing image creator|microsoft designer/i },
  { tool: 'Meta AI', re: /imagined with ai|\bmeta ai\b/i },
  { tool: 'Runway', re: /runwayml|runway gen/i },
  { tool: 'Sora', re: /\bsora\b/i },
  { tool: 'Pika', re: /pika labs|pika\.art/i },
  { tool: 'Kling', re: /kling ?ai/i },
  { tool: 'ElevenLabs', re: /elevenlabs/i },
  { tool: 'Suno', re: /\bsuno\b/i },
  { tool: 'Udio', re: /\budio\b/i },
];

/** Long, distinctive markers safe to search for in raw bytes (short words would match by chance). */
const RAW_MARKERS: { tool: string; needle: string }[] = [
  { tool: 'IPTC trainedAlgorithmicMedia', needle: 'trainedAlgorithmicMedia' },
  { tool: 'Midjourney', needle: 'Midjourney' },
  { tool: 'Stable Diffusion', needle: 'Stable Diffusion' },
  { tool: 'ComfyUI', needle: 'ComfyUI' },
  { tool: 'Adobe Firefly', needle: 'Adobe Firefly' },
];

const EDITORS: { name: string; re: RegExp; aiFace?: boolean }[] = [
  { name: 'FaceApp', re: /faceapp/i, aiFace: true },
  { name: 'Remini', re: /remini/i, aiFace: true },
  { name: 'Lensa', re: /lensa/i, aiFace: true },
  { name: 'Facetune', re: /facetune/i, aiFace: true },
  { name: 'Reface', re: /reface/i, aiFace: true },
  { name: 'Adobe Photoshop', re: /photoshop/i },
  { name: 'Adobe Lightroom', re: /lightroom/i },
  { name: 'GIMP', re: /\bgimp\b/i },
  { name: 'Snapseed', re: /snapseed/i },
  { name: 'PicsArt', re: /picsart/i },
  { name: 'Meitu', re: /meitu/i },
  { name: 'Canva', re: /canva/i },
  { name: 'CapCut', re: /capcut/i },
];

/** Output sizes typical of image generators (common phone/camera sizes are deliberately absent). */
const GENERATOR_SIZES = new Set([
  '512x512',
  '768x768',
  '1024x1024',
  '2048x2048',
  '512x768',
  '768x512',
  '832x1216',
  '1216x832',
  '896x1152',
  '1152x896',
  '1344x768',
  '768x1344',
  '1536x640',
  '640x1536',
  '1792x1024',
  '1024x1792',
  '1536x1024',
  '1024x1536',
  '1456x816',
  '816x1456',
  '1232x928',
  '928x1232',
  '1408x768',
  '768x1408',
  '1280x896',
  '896x1280',
]);

const CAMERA_C2PA = /leica|nikon|sony|canon|fujifilm|truepic|pixel camera|samsung camera|google camera/i;

export function analyzeMedia(bytes: Uint8Array): MediaForensics {
  const meta = parseContainer(bytes);
  const out: Signal[] = [];
  const aiMarkers: MediaForensics['aiMarkers'] = [];
  if (!meta) return { meta: null, aiMarkers, signals: out, insufficientData: true };

  const xmp = meta.xmp ? parseXmp(meta.xmp) : undefined;
  const c2pa = meta.jumbf ? summarizeC2pa(meta.jumbf) : undefined;

  // ---- collect metadata strings with their location
  const fields: [string, string | undefined][] = [
    ['EXIF Software', meta.exif?.software],
    ['EXIF Make', meta.exif?.make],
    ['EXIF Model', meta.exif?.model],
    ['EXIF Artist', meta.exif?.artist],
    ['EXIF ImageDescription', meta.exif?.imageDescription],
    ['EXIF UserComment', meta.exif?.userComment],
    ['XMP CreatorTool', xmp?.creatorTool],
    ['XMP Credit', xmp?.credit],
    ['XMP softwareAgent', xmp?.softwareAgents.join(', ')],
    [
      'C2PA claim generator',
      [c2pa?.claimGenerator, ...(c2pa?.claimGeneratorInfo ?? [])].filter(Boolean).join(', ') || undefined,
    ],
    ['C2PA softwareAgent', c2pa?.softwareAgents.join(', ') || undefined],
    ...Object.entries(meta.iptc).map(([k, v]) => [`IPTC ${k}`, v] as [string, string]),
    ...Object.entries(meta.text).map(
      ([k, v]) =>
        [
          k.startsWith('ID3.') || k.startsWith('INFO.') || k.startsWith('©') ? k : `PNG/text ${k}`,
          `${k}: ${v}`,
        ] as [string, string],
    ),
  ];
  for (const [where, value] of fields) {
    if (!value) continue;
    for (const t of AI_TOOLS) {
      if (t.re.test(value) && !aiMarkers.some((m) => m.tool === t.tool))
        aiMarkers.push({ tool: t.tool, where, value: value.slice(0, 160) });
    }
  }
  if (!aiMarkers.length) {
    const head = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(bytes.byteLength, 4 * 1024 * 1024),
    ).toString('latin1');
    for (const m of RAW_MARKERS) {
      if (head.includes(m.needle) && !aiMarkers.some((x) => x.tool === m.tool))
        aiMarkers.push({ tool: m.tool, where: 'raw bytes', value: m.needle });
    }
  }

  // ---- C2PA / Content Credentials
  const isAiSource = (s?: string) => !!s && /trainedAlgorithmicMedia/i.test(s) && !/composite/i.test(s);
  const isCompositeAi = (s?: string) =>
    !!s && /compositeWithTrainedAlgorithmicMedia|compositeSynthetic/i.test(s);
  if (c2pa) {
    const gen = [c2pa.claimGenerator, ...c2pa.claimGeneratorInfo].filter(Boolean).join(', ');
    const signer = c2pa.signerHints.length
      ? ` · người ký (chưa kiểm chứng): ${c2pa.signerHints.slice(0, 3).join(', ')}`
      : '';
    if (c2pa.digitalSourceTypes.some(isAiSource)) {
      out.push(
        signal(
          'media.c2pa_ai_generated',
          85,
          {
            vi: 'Chứng chỉ nội dung (C2PA) ghi rõ nội dung được tạo bằng AI',
            en: 'Content Credentials (C2PA) state the content was generated by AI',
          },
          'c2pa',
          `${c2pa.digitalSourceTypes.join(', ')}${gen ? ` · ${gen}` : ''}${signer}`,
        ),
      );
    } else if (c2pa.digitalSourceTypes.some(isCompositeAi)) {
      out.push(
        signal(
          'media.c2pa_ai_edited',
          60,
          {
            vi: 'Chứng chỉ nội dung (C2PA) ghi nhận có phần được tạo hoặc chỉnh bằng AI',
            en: 'Content Credentials (C2PA) record AI-generated or AI-edited parts',
          },
          'c2pa',
          `${c2pa.digitalSourceTypes.join(', ')}${gen ? ` · ${gen}` : ''}${signer}`,
        ),
      );
    } else if (gen && CAMERA_C2PA.test(gen) && !aiMarkers.length) {
      out.push(
        signal(
          'media.c2pa_capture',
          -15,
          {
            vi: 'Có chứng chỉ nội dung (C2PA) từ thiết bị chụp (chữ ký chưa được kiểm chứng)',
            en: 'Content Credentials (C2PA) from a capture device (signature not verified)',
          },
          'c2pa',
          `${gen}${signer}`,
        ),
      );
    } else {
      out.push(
        signal(
          'media.c2pa_present',
          0,
          {
            vi: 'Có chứng chỉ nội dung (C2PA); chúng tôi chỉ đọc thông tin khai báo, chưa kiểm chứng chữ ký',
            en: 'Content Credentials (C2PA) present; declared info only, signature not verified',
          },
          'c2pa',
          `${gen || 'không rõ công cụ tạo'}${signer}${c2pa.parseError ? ` · lỗi đọc: ${c2pa.parseError}` : ''}`,
        ),
      );
    }
  }

  // ---- IPTC / XMP digital source type
  const dst = xmp?.digitalSourceType;
  if (dst && isAiSource(dst) && !out.some((s) => s.id === 'media.c2pa_ai_generated')) {
    out.push(
      signal(
        'media.iptc_ai_generated',
        80,
        {
          vi: 'Siêu dữ liệu IPTC đánh dấu nội dung do AI tạo ra (trainedAlgorithmicMedia)',
          en: 'IPTC metadata marks the content as AI-generated (trainedAlgorithmicMedia)',
        },
        'xmp',
        dst,
      ),
    );
  } else if (dst && isCompositeAi(dst) && !out.some((s) => s.id === 'media.c2pa_ai_edited')) {
    out.push(
      signal(
        'media.iptc_ai_edited',
        55,
        {
          vi: 'Siêu dữ liệu IPTC đánh dấu nội dung có phần do AI tạo',
          en: 'IPTC metadata marks the content as partly AI-generated',
        },
        'xmp',
        dst,
      ),
    );
  }

  // ---- generation parameters & tool names
  const sdParams = Object.entries(meta.text).find(
    ([k, v]) =>
      (k === 'parameters' || k === 'Comment' || k === 'Description') &&
      /steps: ?\d+|sampler|cfg scale|seed: ?\d+|negative prompt/i.test(v),
  );
  const comfy = Object.keys(meta.text).find(
    (k) => k === 'workflow' || (k === 'prompt' && /class_type/.test(meta.text[k]!)),
  );
  if (sdParams || comfy) {
    out.push(
      signal(
        'media.generation_parameters',
        80,
        {
          vi: 'Ảnh còn lưu thông số tạo ảnh của phần mềm AI (prompt, sampler, seed…)',
          en: 'The image still contains AI generation parameters (prompt, sampler, seed…)',
        },
        'png_text',
        sdParams ? `${sdParams[0]}: ${sdParams[1].slice(0, 160)}` : `ComfyUI ${comfy}`,
      ),
    );
  }
  if (aiMarkers.length && !out.some((s) => s.weight >= 75)) {
    const m = aiMarkers[0]!;
    const raw = m.where === 'raw bytes';
    out.push(
      signal(
        'media.ai_tool_marker',
        raw ? 50 : 75,
        {
          vi: `Siêu dữ liệu nhắc tới công cụ tạo nội dung bằng AI: ${aiMarkers.map((x) => x.tool).join(', ')}`,
          en: `Metadata mentions an AI generation tool: ${aiMarkers.map((x) => x.tool).join(', ')}`,
        },
        'metadata',
        `${m.where}: ${m.value}`,
      ),
    );
  }

  // ---- editing software
  const editSources = [meta.exif?.software, xmp?.creatorTool, ...(xmp?.softwareAgents ?? [])]
    .filter(Boolean)
    .join(' | ');
  const editor = EDITORS.find((e) => e.re.test(editSources));
  if (editor) {
    out.push(
      editor.aiFace
        ? signal(
            'media.ai_face_app',
            30,
            {
              vi: `Đã qua ứng dụng chỉnh khuôn mặt bằng AI (${editor.name})`,
              en: `Processed with an AI face-editing app (${editor.name})`,
            },
            'metadata',
            editSources.slice(0, 160),
          )
        : signal(
            'media.edited',
            15,
            {
              vi: `Đã được chỉnh sửa bằng phần mềm (${editor.name})`,
              en: `Edited with software (${editor.name})`,
            },
            'metadata',
            editSources.slice(0, 160),
          ),
    );
  }

  // ---- camera data
  const make = meta.exif?.make ?? xmp?.make;
  const model = meta.exif?.model ?? xmp?.model;
  const hasCamera = Boolean(make && model);
  const strongAi = out.some((s) => s.weight >= 50);
  if (meta.kind === 'image') {
    if (hasCamera && !strongAi && !aiMarkers.length) {
      out.push(
        signal(
          'media.camera_metadata',
          meta.exif?.dateTimeOriginal ? -15 : -8,
          {
            vi: 'Có thông tin máy chụp (lưu ý: thông tin này có thể bị làm giả)',
            en: 'Camera information is present (note: it can be faked)',
          },
          'exif',
          [make, model, meta.exif?.dateTimeOriginal].filter(Boolean).join(' · '),
        ),
      );
    } else if (!hasCamera && (meta.format === 'jpeg' || meta.format === 'heic')) {
      out.push(
        signal(
          'media.no_camera_metadata',
          5,
          {
            vi: 'Không có thông tin máy chụp. Rất thường gặp với ảnh đã gửi qua Zalo, Facebook nên chỉ là dấu hiệu yếu',
            en: 'No camera information. Very common after sharing on chat apps, so only a weak sign',
          },
          'exif',
        ),
      );
    }
    const size = meta.width && meta.height ? `${meta.width}x${meta.height}` : null;
    if (size && GENERATOR_SIZES.has(size) && !hasCamera) {
      out.push(
        signal(
          'media.generator_dimensions',
          10,
          {
            vi: `Kích thước ${size} hay gặp ở ảnh do AI tạo (dấu hiệu yếu)`,
            en: `Dimensions ${size} are typical of AI image generators (weak sign)`,
          },
          'dimensions',
          size,
        ),
      );
    }
  }

  const hasAnyMetadata = Boolean(
    meta.exif || meta.xmp || meta.jumbf || Object.keys(meta.iptc).length || Object.keys(meta.text).length,
  );
  const meaningful = out.some((s) => Math.abs(s.weight) >= 10);
  return { meta, xmp, c2pa, aiMarkers, signals: out, insufficientData: !hasAnyMetadata || !meaningful };
}
