export function validModelId(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !/[^A-Za-z0-9._\-\[\]]/.test(value);
}
