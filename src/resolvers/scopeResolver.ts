import {
  ScopeResolution,
  ScopeResolutionOptions,
  ScopeResolver,
  ScopeSelector,
} from '../types';
import { RouterError } from '../router/errors';

export interface SegmentDescriptor {
  id: string;
  labels: string[];
}

const TRL_ID_REGEX = /segments\[(?:segmentId|id)=([^\]]+)]/i;
const TRL_NAME_REGEX = /segments\[name=([^\]]+)]/i;

export class InMemoryScopeResolver implements ScopeResolver {
  private readonly aliasIndex: Map<string, Set<string>>;
  private readonly allScope: ScopeResolution;

  constructor(private readonly segments: SegmentDescriptor[]) {
    this.aliasIndex = new Map();
    segments.forEach((segment) => {
      const labels = new Set<string>([segment.id, ...segment.labels]);
      labels.forEach((label) => {
        const key = this.normalize(label);
        if (!this.aliasIndex.has(key)) {
          this.aliasIndex.set(key, new Set());
        }
        this.aliasIndex.get(key)!.add(segment.id);
      });
    });
    this.allScope = { scope: segments.length ? [...segments.map((s) => s.id)].sort() : [] };
  }

  resolve(selector: ScopeSelector, options?: ScopeResolutionOptions): ScopeResolution {
    const opts = options ?? { required: true };
    if (
      selector === undefined ||
      (Array.isArray(selector) && selector.length === 0) ||
      (typeof selector === 'string' && selector.trim().length === 0)
    ) {
      if (opts.allowAll) {
        return { scope: 'all' };
      }
      if (opts.required) {
        throw new RouterError('EMPTY_SCOPE', 'Selector is required but missing.');
      }
      return { scope: [] };
    }

    const tokens = Array.isArray(selector) ? selector : [selector];
    const normalizedIds = new Set<string>();

    for (const token of tokens) {
      const trimmed = token.trim();
      if (trimmed === '*' || trimmed.toLowerCase() === 'segments' || trimmed.toLowerCase() === 'all') {
        return { scope: 'all' };
      }

      const ids = this.extractIds(trimmed);
      ids.forEach((id) => normalizedIds.add(id));
    }

    if (normalizedIds.size === 0) {
      if (opts.allowAll) {
        return { scope: 'all' };
      }
      throw new RouterError('SEGMENT_NOT_FOUND', `No segment matched selector ${JSON.stringify(selector)}`);
    }

    return { scope: [...normalizedIds].sort() };
  }

  private extractIds(token: string): string[] {
    const byId = token.match(TRL_ID_REGEX);
    if (byId) {
      const [, captured] = byId;
      return captured ? [this.stripQuotes(captured)] : [];
    }

    const byName = token.match(TRL_NAME_REGEX);
    if (byName) {
      const [, captured] = byName;
      if (captured) {
        return [this.resolveAlias(this.stripQuotes(captured))];
      }
      return [];
    }

    return [this.resolveAlias(token)];
  }

  private resolveAlias(raw: string): string {
    const key = this.normalize(raw);
    const matches = this.aliasIndex.get(key);
    if (!matches || matches.size === 0) {
      throw new RouterError('SEGMENT_NOT_FOUND', `No segment found for selector "${raw}"`);
    }
    if (matches.size > 1) {
      throw new RouterError(
        'SEGMENT_NOT_UNIQUE',
        `Selector "${raw}" matched multiple segments: ${[...matches].join(', ')}`,
      );
    }
    const [first] = matches;
    if (!first) {
      throw new RouterError('SEGMENT_NOT_FOUND', `No segment found for selector "${raw}"`);
    }
    return first;
  }

  private normalize(value: string): string {
    return value.replace(/['"]/g, '').trim().toLowerCase();
  }

  private stripQuotes(value: string): string {
    return value.replace(/^['"]/, '').replace(/['"]$/, '');
  }
}
