/** Longest object path shown before it is shortened in the middle. */
export const OBJECT_PATH_MAX_LENGTH = 56;

export function middleEllipsis(
  text: string,
  maxLength = OBJECT_PATH_MAX_LENGTH,
): string {
  const characters = [...text];
  if (characters.length <= maxLength) return text;
  const kept = maxLength - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return `${characters.slice(0, head).join("")}…${characters
    .slice(characters.length - tail)
    .join("")}`;
}
