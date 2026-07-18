import { z } from 'zod';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

// visualize — 답변 흐름 안에 인라인으로 그려지는 턴 출력 위젯. 아티팩트와
// 달리 지속 문서가 아니라 tool_call에 묶인 뷰이며, 렌더 원본은 호출 인자
// (code)다. 도구 결과는 모델에 되돌아가는 작은 확인 응답만 담아 코드가
// 히스토리에 두 번 실리지 않게 한다. 실제 렌더는 web-shell 트랜스크립트가
// 샌드박스 인라인 프레임으로 수행한다.
const visualizeArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1, 'code is required.')
    .describe(
      'Widget markup: a complete <svg> element, or an HTML fragment without doctype/html/head/body wrappers.',
    ),
  title: z
    .string()
    .optional()
    .describe('Optional short accessible title for the widget.'),
});

export const visualizeTool = defineZodTool({
  name: 'visualize',
  description:
    'Render an inline visual widget (SVG or an HTML fragment) directly inside the current chat turn. The widget is displayed in a sandboxed inline frame with a preset stylesheet and a sendPrompt(text) bridge. It lives inside this turn only — it is not a persistent artifact.',
  argsSchema: visualizeArgsSchema,
  sideEffectLevel: 'none',
  // 코드가 도착하는 대로 위젯이 실시간으로 그려지도록 인자 스트리밍 opt-in
  streamsArgsDelta: true,
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'presentation',
    searchHints: ['visualize', 'inline widget', 'diagram', 'chart', 'svg'],
    tags: ['visualize', 'widget', 'inline', 'diagram'],
    whenToUse:
      'Show a small diagram, chart, mockup, or lightweight interactive visual inline while answering.',
    notFor:
      'Persistent documents, dashboards, or apps the user will reopen, update, or share — use an artifact instead.',
  },
  async executeParsed(args) {
    const code = args.code.trim();
    if (code === '') {
      return toolError('execution_failed', 'visualize code must not be blank.');
    }
    const mode = code.toLowerCase().startsWith('<svg') ? 'svg' : 'html';
    return {
      ok: true,
      output: JSON.stringify({
        rendered: true,
        mode,
        ...(args.title !== undefined && args.title.trim() !== ''
          ? { title: args.title.trim() }
          : {}),
      }),
    };
  },
});
