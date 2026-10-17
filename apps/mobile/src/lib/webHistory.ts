import { Platform } from 'react-native';

// The browser's history on the web. Pages push entries (`?page=`, `?recipe=`); an open sheet owns
// one more entry on top of its page, so the browser's Back closes the sheet, as Escape and
// Android's back button do, rather than changing the page beneath it. Native apps keep no history.
const web = Platform.OS === 'web' && typeof window !== 'undefined';
// Whether the current entry is the open sheet's.
let sheetOnTop = false;
// Set while a closed sheet's entry is being taken back: the Back it sends is not the cook's, and
// history changes wait for it, or they would land on the wrong entry.
let settling: (() => void)[] | null = null;

/** Records a new page. One opened from a sheet takes the sheet's entry, as the sheet is closing. */
export function pushPage(url: string) {
  if (!web) return;
  if (settling) return void settling.push(() => pushPage(url));
  if (sheetOnTop) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
  sheetOnTop = false;
}

/** Changes the current page's address without a new entry. */
export function replacePage(url: string) {
  if (!web) return;
  if (settling) return void settling.push(() => replacePage(url));
  window.history.replaceState({}, '', url);
}

/** A sheet is showing: give it an entry of its own, unless it already has one. */
export function sheetShown() {
  if (!web || sheetOnTop) return;
  if (settling) return void settling.push(sheetShown);
  window.history.pushState(window.history.state, '');
  sheetOnTop = true;
}

const settle = () => {
  const waiting = settling ?? [];
  settling = null;
  waiting.forEach((next) => next());
};

/** The last sheet closed by its own controls: take its entry back. */
export function sheetsGone() {
  if (!web || !sheetOnTop) return;
  sheetOnTop = false;
  // The page may have changed its address while the sheet was open (an admin tab, say); that
  // address outlives the sheet's entry.
  const address = window.location.href;
  const waiting = [
    () =>
      window.location.href !== address &&
      window.history.replaceState(window.history.state, '', address),
  ];
  settling = waiting;
  window.history.back();
  // Should that Back never land (the page is being left, say), stop holding history changes.
  setTimeout(() => settling === waiting && settle(), 1000);
}

// One popstate listener decides whose Back it was. Listeners on the window run in the order they
// were added, capturing or not, so a separate listener could not reliably keep a sheet's Back from
// the page's own handling.
const sheetListeners = new Set<() => void>();
const pageListeners = new Set<() => void>();
if (web)
  window.addEventListener('popstate', () => {
    if (settling) settle();
    else if (sheetOnTop) {
      sheetOnTop = false;
      sheetListeners.forEach((listener) => listener());
    } else pageListeners.forEach((listener) => listener());
  });

/** Calls `onBack` when the browser's Back leaves an open sheet's entry. Returns the unsubscribe. */
export function onSheetBack(onBack: () => void) {
  if (!web) return () => {};
  sheetListeners.add(onBack);
  return () => {
    sheetListeners.delete(onBack);
  };
}

/**
 * Calls `onPage` when the browser moves between pages, never for the entries sheets use (their
 * Back closes the sheet). Pages listen here instead of on popstate. Returns the unsubscribe.
 */
export function onPageBack(onPage: () => void) {
  if (!web) return () => {};
  pageListeners.add(onPage);
  return () => {
    pageListeners.delete(onPage);
  };
}
