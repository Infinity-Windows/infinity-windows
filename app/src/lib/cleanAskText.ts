/** Plain display text only. Keep the original reply for follow-up context and
 * leave structured report numbers untouched. React escapes the result. */
export function cleanAskText(text: string): string {
  return text
    .replace(/^\s*```[^\n]*\n/gm, '')
    .replace(/^\s*```\s*$/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/__([^\n]+?)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,!:;?])/g, '$1$2')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*+]\s+(?=\S)/gm, '• ')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .trim();
}
