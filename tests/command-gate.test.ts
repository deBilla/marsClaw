import { describe, it, expect } from 'bun:test';
import { gateCommand } from '../src/lib/command-gate.ts';

describe('gateCommand', () => {
  it('filters known interactive-CLI commands', () => {
    expect(gateCommand('/help')).toBe('filter');
    expect(gateCommand('/clear')).toBe('filter');
    expect(gateCommand('/compact')).toBe('filter');
    expect(gateCommand('/login')).toBe('filter');
    expect(gateCommand('/cost')).toBe('filter');
  });

  it('filters with leading whitespace', () => {
    expect(gateCommand('   /help')).toBe('filter');
  });

  it('filters case-insensitively', () => {
    expect(gateCommand('/HELP')).toBe('filter');
    expect(gateCommand('/Clear')).toBe('filter');
  });

  it('filters when command has args', () => {
    expect(gateCommand('/clear all history')).toBe('filter');
  });

  it('passes regular text', () => {
    expect(gateCommand('hello there')).toBe('pass');
    expect(gateCommand('what is the time?')).toBe('pass');
  });

  it('passes unknown slash-commands (agent may handle them)', () => {
    expect(gateCommand('/agentcommand')).toBe('pass');
    expect(gateCommand('/foo')).toBe('pass');
  });
});
