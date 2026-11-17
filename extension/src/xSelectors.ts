export const X_SELECTORS = {
  composerTextarea: [
    'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
    '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
    '[data-testid="tweetTextarea_0"]',
  ],
  modalComposerTextarea: [
    '[role="dialog"] div[contenteditable="true"][data-testid="tweetTextarea_0"]',
    '[role="dialog"] [data-testid="tweetTextarea_0"] [contenteditable="true"]',
    '[role="dialog"] [data-testid="tweetTextarea_0"]',
    'div[contenteditable="true"][data-testid="tweetTextarea_0"]',
    '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
    '[data-testid="tweetTextarea_0"]',
  ],
  inlineSubmitButton: ['[data-testid="tweetButtonInline"]'],
  modalSubmitButton: ['[data-testid="tweetButton"]'],
  replyButton: ['[data-testid="reply"]'],
  retweetButton: ['[data-testid="retweet"]'],
  retweetConfirmButton: ['[data-testid="retweetConfirm"]'],
  quoteMenuItem: [
    '[data-testid="Dropdown"] a[href="/compose/post"]',
    'a[href="/compose/post"][role="menuitem"]',
    '[data-testid="Dropdown"] [role="menuitem"]:nth-child(2)',
  ],
  tweetText: ['[data-testid="tweetText"]'],
} as const;

export function extractStatusId(targetUrl?: string): string | undefined {
  if (!targetUrl) return undefined;
  const match = targetUrl.match(/\/status\/(\d+)/);
  return match?.[1];
}
