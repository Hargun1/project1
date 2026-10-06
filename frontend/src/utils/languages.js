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
