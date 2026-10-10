/**
 * Maps the document `language` column value (lowercase, e.g. "javascript", "cpp")
 * to the Monaco Editor language identifier.
 *
 * §31: Initially JavaScript, TypeScript, Java, Python, C++, HTML, CSS, JSON.
 * The list is extensible — just add an entry here.
 */

/** @type {Record<string, string>} */
export const LANGUAGE_MAP = {
  javascript: 'javascript',
  typescript: 'typescript',
  java: 'java',
  python: 'python',
  cpp: 'cpp',
  html: 'html',
  css: 'css',
  json: 'json',
};

/** @type {{ value: string, label: string }[]} */
export const LANGUAGE_OPTIONS = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
  { value: 'cpp', label: 'C++' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
];

/**
 * Monaco language ID for a given database language value.
 * Falls back to 'plaintext' for unrecognized values.
 * @param {string} language
 * @returns {string}
 */
export function monacoLanguage(language) {
  return LANGUAGE_MAP[language] ?? 'plaintext';
}

/** File extension → document language, for naming a new document "main.py". */
const EXTENSION_LANGUAGE = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  py: 'python',
  java: 'java',
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  html: 'html',
  htm: 'html',
  css: 'css',
  json: 'json',
};

/**
 * The language a file name implies, e.g. "main.py" → "python".
 *
 * @param {string} name
 * @returns {string | null} null when there is no known extension
 */
export function languageFromFileName(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? (EXTENSION_LANGUAGE[match[1].toLowerCase()] ?? null) : null;
}

/**
 * Display label for a language value ("cpp" → "C++").
 *
 * @param {string} value
 * @returns {string}
 */
export function languageLabel(value) {
  return LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
