import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

// react-test-renderer 조회 헬퍼. Assistant.test.tsx 안의 지역 함수였고,
// 테마별 Assistant 테스트로 나눌 때 여러 파일이 같은 조회를 쓰도록
// 여기로 올렸다. 본문은 이동 전과 동일하다.
export function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}

export function findButtonByText(renderer: ReactTestRenderer, text: string) {
  return renderer.root
    .findAllByType('button')
    .find((button) => renderedText(button).includes(text));
}
