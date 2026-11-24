/**
 * Config loading: defaults <- user config JSON <- project .dbghub.json (safe keys only).
 * v1 deliberately has no YAML parser; contract allows JSON now and YAML in a later phase.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, knownCandidates } from './defaults.mjs';

const SAFE_PROJECT_KEYS = new Set(['program', 'symbols', 'source_map', 'symbol_paths', 'profile', 'images']);
const UNSAFE_PROJECT_KEYS = ['server', 'command', 'hooks', 'allow_raw', 'allow_attach', 'backends', 'profiles', 'pid'];

export function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${e.message}`);
  }
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

/** Resolve named commands in defaults to absolute paths when a known candidate exists. */
export function resolveToolPaths(config, env = process.env) {
  const cand = knownCandidates(env);
  const cfg = structuredClone(config);
  const gdbMap = { gdb: 'gdb', 'arm-none-eabi-gdb': 'arm-none-eabi-gdb' };
  for (const [profile, p] of Object.entries(cfg.profiles || {})) {
    if (!p.gdb || p.gdb === 'auto') continue;
    const key = gdbMap[p.gdb];
    if (key) {
      const resolved = firstExisting(cand[gdbMap[key]] || []);
      if (resolved) cfg.profiles[profile].gdb = resolved;
    }
  }
  const oc = cfg.backends?.openocd;
  if (oc) {
    if (!oc.command || oc.command === 'openocd') {
      const resolved = firstExisting(cand.openocd);
      if (resolved) oc.command = resolved;
    }
    if (!oc.search) {
      const resolved = firstExisting(cand.openocdScripts);
      if (resolved) oc.search = resolved;
    }
  }
  return cfg;
}

export function findProjectConfig(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of ['.dbghub.json', '.dbghub.yaml']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig({ cwd = process.cwd(), env = process.env, userConfig = null } = {}) {
  const warnings = [];
  let cfg = structuredClone(DEFAULT_CONFIG);

  const userPath = userConfig || env.DBGHUB_CONFIG || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dbghub', 'config.json');
  if (userPath && fs.existsSync(userPath)) {
    try {
      cfg = deepMerge(cfg, readJson(userPath));
    } catch (e) {
      warnings.push(`user config ignored: ${e.message}`);
    }
  }

  const projectPath = findProjectConfig(cwd);
  let project = {};
  if (projectPath) {
    if (projectPath.endsWith('.yaml')) {
      warnings.push(`project YAML not supported in v1, ignored: ${projectPath}`);
    } else {
      try {
        const raw = readJson(projectPath);
        for (const [k, v] of Object.entries(raw)) {
          if (SAFE_PROJECT_KEYS.has(k)) project[k] = v;
          else warnings.push(`project config key ignored (unsafe or unknown): ${k}`);
        }
      } catch (e) {
        warnings.push(`project config ignored: ${e.message}`);
      }
    }
  }

  if (project.program) cfg.project = { ...(cfg.project || {}), program: project.program };
  if (Array.isArray(project.symbols)) cfg.project = { ...(cfg.project || {}), symbols: project.symbols };
  if (Array.isArray(project.source_map)) cfg.workspace.source_map = project.source_map;
  if (Array.isArray(project.symbol_paths)) cfg.workspace.symbol_paths = project.symbol_paths;
  if (project.profile) cfg.project = { ...(cfg.project || {}), profile: project.profile };

  cfg = resolveToolPaths(cfg, env);
  cfg._meta = { projectConfigPath: projectPath, userConfigPath: fs.existsSync(userPath || '') ? userPath : null, warnings };
  return cfg;
}

export function getProfile(config, name) {
  if (!name) return null;
  return config.profiles?.[name] || null;
}
