export function queueNoteLinksRequest(
  previous: Promise<void>,
  isCurrent: () => boolean,
  request: () => Promise<void>,
): Promise<void> {
  return previous.then(async () => {
    if (isCurrent()) {
      await request();
    }
  });
}
