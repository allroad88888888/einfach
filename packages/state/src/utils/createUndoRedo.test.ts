import { describe, expect, test } from '@jest/globals';
import { atom, createStore } from '../core';
import { createUndoRedo } from './createUndoRedo';

describe('undo redo ', () => {
  test('easy', () => {
    const numberAtom = atom(0);
    const store = createStore();

    const { undoAtom, redoAtom, watchAtom } = createUndoRedo(store);
    watchAtom(numberAtom);
    expect(store.getter(undoAtom)).toBe(false);
    expect(store.getter(redoAtom)).toBe(false);
    store.setter(numberAtom, 1);
    store.setter(numberAtom, 2);
    store.setter(numberAtom, 3);
    expect(store.getter(undoAtom)).toBe(true);
    expect(store.getter(redoAtom)).toBe(false);
    store.setter(undoAtom);
    expect(store.getter(undoAtom)).toBe(true);
    expect(store.getter(redoAtom)).toBe(true);
    expect(store.getter(numberAtom)).toBe(2);
    store.setter(undoAtom);
    expect(store.getter(numberAtom)).toBe(1);
    store.setter(redoAtom);
    store.setter(redoAtom);
    expect(store.getter(numberAtom)).toBe(3);
    expect(store.getter(undoAtom)).toBe(true);
    expect(store.getter(redoAtom)).toBe(false);
  });

  test('double', () => {
    const numberAtom = atom(0);
    const stringAtom = atom('');
    const store = createStore();
    const { undoAtom, redoAtom, watchAtom, undo, redo } = createUndoRedo(store);
    watchAtom(numberAtom);
    watchAtom(stringAtom);

    store.setter(numberAtom, 1);
    store.setter(stringAtom, 'init');
    store.setter(numberAtom, 2);
    expect(store.getter(undoAtom)).toBe(true);
    expect(store.getter(redoAtom)).toBe(false);

    undo();
    expect(store.getter(numberAtom)).toBe(1);
    expect(store.getter(stringAtom)).toBe('init');
    undo();
    expect(store.getter(numberAtom)).toBe(1);
    expect(store.getter(stringAtom)).toBe('');
    redo();
    expect(store.getter(numberAtom)).toBe(1);
    expect(store.getter(stringAtom)).toBe('init');
  });

  test('transaction', () => {
    const numberAtom = atom(0);
    const stringAtom = atom('');
    const store = createStore();
    const { watchAtom, undo, redo, historyTransactionEnd, historyTransactionStart } =
      createUndoRedo(store);
    watchAtom(numberAtom);
    watchAtom(stringAtom);

    historyTransactionStart();
    store.setter(numberAtom, 1);
    store.setter(stringAtom, 'init');
    store.setter(numberAtom, 2);
    historyTransactionEnd();

    undo();
    expect(store.getter(numberAtom)).toBe(0);
    expect(store.getter(stringAtom)).toBe('');
    redo();
    expect(store.getter(numberAtom)).toBe(2);
    expect(store.getter(stringAtom)).toBe('init');
  });
});
