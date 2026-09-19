// Global test setup for the client suite: jest-dom matchers + jsdom shims.
import '@testing-library/jest-dom/vitest';

if (!window.matchMedia) {
  window.matchMedia = (query) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
}
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
}
if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {}, readText: async () => '' }, configurable: true });
}
