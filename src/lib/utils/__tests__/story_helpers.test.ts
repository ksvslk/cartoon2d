import { describe, it, expect } from 'vitest';
import {
  estimateStoryboardGenerationCost,
  estimateProPreviewTextCost,
  findCompiledBinding,
  classifyCompileLogLine,
  getBeatImageGenerationCost,
  sanitizeDurationSeconds,
  clampNumber,
  extractRigViews,
  selectRequiredRigViews,
  buildActorRigDescription,
  inferRigRefreshReason,
  findActorReferenceTransform,
  collectActorReferenceSamples,
  estimateActorReferenceBounds,
  buildActorReuseKey,
  cloneAnimationClip,
  GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS,
  GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD,
  PLAYHEAD_UI_SYNC_MS,
  BASE_EXPORT_RESOLUTIONS,
} from '@/lib/utils/story_helpers';
import type { CompiledSceneData, StoryBeatData } from '@/lib/schema/story';

// ── Constants ──────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS is a positive integer', () => {
    expect(GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS).toBe(747);
  });

  it('GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD is a small positive number', () => {
    expect(GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD).toBeGreaterThan(0);
    expect(GEMINI_31_FLASH_IMAGE_512_MIN_IMAGE_COST_USD).toBeLessThan(1);
  });

  it('PLAYHEAD_UI_SYNC_MS is 50', () => {
    expect(PLAYHEAD_UI_SYNC_MS).toBe(50);
  });

  it('BASE_EXPORT_RESOLUTIONS has expected keys', () => {
    expect(Object.keys(BASE_EXPORT_RESOLUTIONS)).toEqual(['720p', '1080p', '4k', '8k']);
    expect(BASE_EXPORT_RESOLUTIONS['1080p']).toEqual({ label: '1080p FHD', width: 1920, height: 1080 });
  });
});

// ── Cost estimation ────────────────────────────────────────────────────────────

describe('estimateStoryboardGenerationCost', () => {
  it('returns zero cost for zero tokens', () => {
    const result = estimateStoryboardGenerationCost(0, 0, 0);
    expect(result.totalCost).toBe(0);
    expect(result.imageOutputTokens).toBe(0);
    expect(result.textOutputTokens).toBe(0);
  });

  it('attributes output tokens to images first', () => {
    const result = estimateStoryboardGenerationCost(1000, 1000, 2);
    // 2 images × 747 tokens = 1494 max, but only 1000 candidate tokens
    expect(result.imageOutputTokens).toBe(1000);
    expect(result.textOutputTokens).toBe(0);
  });

  it('splits tokens between text and images correctly', () => {
    const result = estimateStoryboardGenerationCost(1000, 2000, 1);
    // 1 image × 747 = 747 image tokens, rest = text
    expect(result.imageOutputTokens).toBe(747);
    expect(result.textOutputTokens).toBe(2000 - 747);
    expect(result.totalCost).toBeGreaterThan(0);
  });
});

describe('estimateProPreviewTextCost', () => {
  it('returns zero cost for zero tokens', () => {
    expect(estimateProPreviewTextCost(0, 0)).toBe(0);
  });

  it('returns positive cost for positive tokens', () => {
    expect(estimateProPreviewTextCost(100, 100)).toBeGreaterThan(0);
  });

  it('large prompt uses higher rates', () => {
    const smallCost = estimateProPreviewTextCost(100, 100);
    const largeCost = estimateProPreviewTextCost(300000, 100);
    // Large prompt rate is higher, so same output with more input = more cost
    expect(largeCost).toBeGreaterThan(smallCost);
  });
});

// ── findCompiledBinding ────────────────────────────────────────────────────────

describe('findCompiledBinding', () => {
  const mockScene: CompiledSceneData = {
    duration_seconds: 5,
    background_ambient: [],
    obstacles: [],
    instance_tracks: [
      {
        actor_id: 'actor_1',
        clip_bindings: [
          {
            id: 'binding_0',
            actor_id: 'actor_1',
            source_action_index: 0,
            motion: 'walk',
            style: 'normal',
            clip_id: 'walk',
            start_time: 0,
            duration_seconds: 2,
            start_transform: { x: 100, y: 200, scale: 0.5, z_index: 10 },
          },
          {
            id: 'binding_1',
            actor_id: 'actor_1',
            source_action_index: 2,
            motion: 'idle',
            style: 'normal',
            clip_id: 'idle',
            start_time: 2,
            duration_seconds: 3,
            start_transform: { x: 300, y: 200, scale: 0.5, z_index: 10 },
          },
        ],
        transform_track: [],
      },
    ],
  };

  it('returns null for null scene', () => {
    expect(findCompiledBinding(null, 0)).toBeNull();
  });

  it('returns null for null actionIndex', () => {
    expect(findCompiledBinding(mockScene, null)).toBeNull();
  });

  it('finds binding by source_action_index 0', () => {
    const result = findCompiledBinding(mockScene, 0);
    expect(result).not.toBeNull();
    expect(result!.binding.id).toBe('binding_0');
    expect(result!.trackIndex).toBe(0);
    expect(result!.bindingIndex).toBe(0);
  });

  it('finds binding by source_action_index 2', () => {
    const result = findCompiledBinding(mockScene, 2);
    expect(result).not.toBeNull();
    expect(result!.binding.id).toBe('binding_1');
    expect(result!.bindingIndex).toBe(1);
  });

  it('returns null for non-existent action index', () => {
    expect(findCompiledBinding(mockScene, 99)).toBeNull();
  });
});

// ── classifyCompileLogLine ─────────────────────────────────────────────────────

describe('classifyCompileLogLine', () => {
  it('classifies [PAID] lines', () => {
    expect(classifyCompileLogLine('[PAID] Generated motion clip')).toBe('paid');
  });

  it('classifies [REUSED] lines', () => {
    expect(classifyCompileLogLine('[REUSED] Using cached clip')).toBe('reused');
  });

  it('classifies [BLOCKED] lines as error', () => {
    expect(classifyCompileLogLine('[BLOCKED] No valid rig')).toBe('error');
  });

  it('classifies [DEBUG] lines', () => {
    expect(classifyCompileLogLine('[DEBUG] Test info')).toBe('debug');
  });

  it('classifies [REVIEW] lines', () => {
    expect(classifyCompileLogLine('[REVIEW] Check this')).toBe('review');
  });

  it('classifies ❌ lines as error', () => {
    expect(classifyCompileLogLine('❌ Something failed')).toBe('error');
  });

  it('classifies normal lines as neutral', () => {
    expect(classifyCompileLogLine('Normal log line')).toBe('neutral');
  });
});

// ── sanitizeDurationSeconds ────────────────────────────────────────────────────

describe('sanitizeDurationSeconds', () => {
  it('returns fallback for null', () => {
    expect(sanitizeDurationSeconds(null)).toBe(10);
  });

  it('returns fallback for undefined', () => {
    expect(sanitizeDurationSeconds(undefined)).toBe(10);
  });

  it('returns fallback for 0', () => {
    expect(sanitizeDurationSeconds(0)).toBe(10);
  });

  it('returns fallback for negative', () => {
    expect(sanitizeDurationSeconds(-5)).toBe(10);
  });

  it('returns fallback for NaN', () => {
    expect(sanitizeDurationSeconds(NaN)).toBe(10);
  });

  it('returns fallback for Infinity', () => {
    expect(sanitizeDurationSeconds(Infinity)).toBe(10);
  });

  it('passes through valid values', () => {
    expect(sanitizeDurationSeconds(5)).toBe(5);
  });

  it('clamps minimum to 0.1', () => {
    expect(sanitizeDurationSeconds(0.01)).toBe(0.1);
  });

  it('clamps maximum to 3600', () => {
    expect(sanitizeDurationSeconds(99999)).toBe(3600);
  });

  it('uses custom fallback', () => {
    expect(sanitizeDurationSeconds(null, 3)).toBe(3);
  });
});

// ── clampNumber ────────────────────────────────────────────────────────────────

describe('clampNumber', () => {
  it('clamps below minimum', () => {
    expect(clampNumber(-5, 0, 10)).toBe(0);
  });

  it('clamps above maximum', () => {
    expect(clampNumber(15, 0, 10)).toBe(10);
  });

  it('passes through values in range', () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
  });

  it('returns min when value equals min', () => {
    expect(clampNumber(0, 0, 10)).toBe(0);
  });

  it('returns max when value equals max', () => {
    expect(clampNumber(10, 0, 10)).toBe(10);
  });
});

// ── extractRigViews ────────────────────────────────────────────────────────────

describe('extractRigViews', () => {
  it('extracts view IDs from SVG data', () => {
    const svg = '<g id="view_3q_right"></g><g id="view_front"></g>';
    const views = extractRigViews(svg);
    expect(views).toContain('view_3q_right');
    expect(views).toContain('view_front');
  });

  it('returns default for SVG without views', () => {
    const svg = '<g id="body"></g>';
    const views = extractRigViews(svg);
    expect(views).toContain('view_3q_right');
  });

  it('handles both quote styles', () => {
    const svg = "<g id='view_side_left'></g>";
    const views = extractRigViews(svg);
    expect(views.length).toBeGreaterThan(0);
  });
});

// ── selectRequiredRigViews ─────────────────────────────────────────────────────

describe('selectRequiredRigViews', () => {
  it('requests primary view when no existing views', () => {
    const result = selectRequiredRigViews({ plannedViews: ['view_front'] });
    expect(result.requestedViews).toContain('view_front');
    expect(result.missingViews).toContain('view_front');
    expect(result.primaryObservedView).toBe('view_front');
  });

  it('reports no missing when view exists', () => {
    const result = selectRequiredRigViews({
      plannedViews: ['view_front'],
      existingViews: ['view_front', 'view_3q_right'],
    });
    expect(result.missingViews).toEqual([]);
  });

  it('reports missing when planned view not in existing', () => {
    const result = selectRequiredRigViews({
      plannedViews: ['view_front'],
      existingViews: ['view_3q_right'],
    });
    expect(result.missingViews).toContain('view_front');
  });
});

// ── buildActorRigDescription ───────────────────────────────────────────────────

describe('buildActorRigDescription', () => {
  it('formats actor description correctly', () => {
    const actor = {
      id: 'actor_1',
      name: 'Rex',
      species: 'T-Rex',
      personality: 'Friendly',
      attributes: ['green', 'large', 'toothy'],
      visual_description: 'A big green dinosaur.',
    } as any;

    const desc = buildActorRigDescription(actor);
    expect(desc).toContain('Rex');
    expect(desc).toContain('T-Rex');
    expect(desc).toContain('Friendly');
    expect(desc).toContain('green, large, toothy');
    expect(desc).toContain('A big green dinosaur.');
  });
});

// ── inferRigRefreshReason ──────────────────────────────────────────────────────

describe('inferRigRefreshReason', () => {
  it('returns reason for undefined rig', () => {
    expect(inferRigRefreshReason(undefined)).not.toBeNull();
  });

  it('returns reason for rig without IK', () => {
    const rig = { rig_data: {} } as any;
    expect(inferRigRefreshReason(rig)).toBe('canonical IK is missing');
  });

  it('returns reason for low confidence', () => {
    const rig = {
      rig_data: { ik: { aiReport: { confidence: 0.3, warnings: [] } } },
    } as any;
    const reason = inferRigRefreshReason(rig);
    expect(reason).toContain('confidence');
  });

  it('returns null for high-quality rig', () => {
    const rig = {
      rig_data: { ik: { aiReport: { confidence: 0.9, warnings: [] } } },
    } as any;
    expect(inferRigRefreshReason(rig)).toBeNull();
  });

  it('returns reason for multiple attachment warnings', () => {
    const rig = {
      rig_data: {
        ik: {
          aiReport: {
            confidence: 0.7,
            warnings: [
              'attachment gap on node_1',
              'no explicit attachment socket on node_2',
            ],
          },
        },
      },
    } as any;
    const reason = inferRigRefreshReason(rig);
    expect(reason).toContain('attachment');
  });
});

// ── findActorReferenceTransform ────────────────────────────────────────────────

describe('findActorReferenceTransform', () => {
  it('returns null for beat with no matching actor', () => {
    const beat: StoryBeatData = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions: [],
      comic_panel_prompt: '',
    };
    expect(findActorReferenceTransform(beat, 'missing_actor')).toBeNull();
  });

  it('returns spatial_transform from action', () => {
    const beat: StoryBeatData = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions: [
        {
          actor_id: 'actor_1',
          motion: 'idle',
          style: '',
          start_time: 0,
          duration_seconds: 2,
          spatial_transform: { x: 500, y: 800, scale: 0.6, z_index: 10 },
        },
      ],
      comic_panel_prompt: '',
    };
    const result = findActorReferenceTransform(beat, 'actor_1');
    expect(result).not.toBeNull();
    expect(result!.x).toBe(500);
    expect(result!.y).toBe(800);
  });
});

// ── collectActorReferenceSamples ───────────────────────────────────────────────

describe('collectActorReferenceSamples', () => {
  it('returns empty for no actions', () => {
    const beat: StoryBeatData = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions: [],
      comic_panel_prompt: '',
    };
    const samples = collectActorReferenceSamples(beat, 'actor_1', []);
    expect(samples).toEqual([]);
  });

  it('collects spatial_transform samples', () => {
    const actions = [
      {
        actor_id: 'actor_1',
        motion: 'walk',
        style: '',
        start_time: 0,
        duration_seconds: 2,
        spatial_transform: { x: 100, y: 200, scale: 0.5, z_index: 10 },
        target_spatial_transform: { x: 400, y: 300, scale: 0.7 },
      },
    ];
    const beat: StoryBeatData = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions,
      comic_panel_prompt: '',
    };

    const samples = collectActorReferenceSamples(beat, 'actor_1', actions as any);
    expect(samples.length).toBe(2);
    expect(samples[0]).toEqual({ x: 100, y: 200, scale: 0.5 });
    expect(samples[1]).toEqual({ x: 400, y: 300, scale: 0.7 });
  });
});

// ── estimateActorReferenceBounds ───────────────────────────────────────────────

describe('estimateActorReferenceBounds', () => {
  it('returns null for empty samples', () => {
    expect(estimateActorReferenceBounds({ samples: [], stageW: 1920, stageH: 1080 })).toBeNull();
  });

  it('returns bounds for valid samples', () => {
    const samples = [
      { x: 500, y: 800, scale: 0.5 },
      { x: 900, y: 850, scale: 0.6 },
    ];
    const bounds = estimateActorReferenceBounds({ samples, stageW: 1920, stageH: 1080 });
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeGreaterThan(0);
    expect(bounds!.height).toBeGreaterThan(0);
    // Should be within stage bounds
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1920);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1080);
  });
});

// ── getBeatImageGenerationCost ─────────────────────────────────────────────────

describe('getBeatImageGenerationCost', () => {
  it('returns null for undefined beat', () => {
    expect(getBeatImageGenerationCost(undefined, 0, {})).toBeNull();
  });

  it('returns null for beat without image', () => {
    const beat: StoryBeatData = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions: [],
      comic_panel_prompt: '',
    };
    expect(getBeatImageGenerationCost(beat, 0, {})).toBeNull();
  });

  it('returns transient cost if available', () => {
    const transient = { 0: { tokens: 500, cost: 0.05 } };
    const beat: StoryBeatData = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions: [],
      comic_panel_prompt: '',
    };
    const result = getBeatImageGenerationCost(beat, 0, transient);
    expect(result).toEqual({ tokens: 500, cost: 0.05 });
  });

  it('returns minimum estimate for beat with image but no cost data', () => {
    const beat = {
      scene_number: 1,
      narrative: '',
      cameras: [{ start_time: 0, zoom: 1, x: 960, y: 540, rotation: 0 }],
      audio: [],
      actions: [],
      comic_panel_prompt: '',
      image_data: 'data:image/png;base64,abc',
    } as StoryBeatData;
    const result = getBeatImageGenerationCost(beat, 0, {});
    expect(result).not.toBeNull();
    expect(result!.tokens).toBe(GEMINI_31_FLASH_IMAGE_512_OUTPUT_TOKENS);
  });
});

// ── buildActorReuseKey ─────────────────────────────────────────────────────────

describe('buildActorReuseKey', () => {
  it('generates consistent keys for same actor', () => {
    const actor = { name: 'Rex', species: 'T-Rex' } as any;
    const key1 = buildActorReuseKey(actor);
    const key2 = buildActorReuseKey(actor);
    expect(key1).toBe(key2);
  });

  it('generates different keys for different species', () => {
    const actor1 = { name: 'Rex', species: 'T-Rex' } as any;
    const actor2 = { name: 'Rex', species: 'Raptor' } as any;
    expect(buildActorReuseKey(actor1)).not.toBe(buildActorReuseKey(actor2));
  });
});

// ── cloneAnimationClip ─────────────────────────────────────────────────────────

describe('cloneAnimationClip', () => {
  it('creates a deep clone', () => {
    const original = { a: 1, b: { c: [1, 2, 3] } };
    const clone = cloneAnimationClip(original);
    expect(clone).toEqual(original);
    expect(clone).not.toBe(original);
    expect(clone.b).not.toBe(original.b);
    expect(clone.b.c).not.toBe(original.b.c);
  });

  it('mutating clone does not affect original', () => {
    const original = { nested: { val: 42 } };
    const clone = cloneAnimationClip(original);
    clone.nested.val = 99;
    expect(original.nested.val).toBe(42);
  });
});
