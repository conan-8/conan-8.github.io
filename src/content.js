// ============================================================================
// THE ELEVATOR — Phase 2
// src/content.js — single source of truth for ALL user content.
//
// Byte-exact per ELEVATOR_SPEC.md "Global Contract / content.js":
//   SITE    — { name, tagline }
//   FLOORS  — the six-floor manifest ({ n, id, label, status, flash })
//
// `flash` is the color glimpsed through the door crack when passing that
// floor. Floor modules receive their project data from here — no hardcoded
// content inside floor scenes. PROJECTS data arrives in a later phase.
// ============================================================================

export const SITE = { name: "CONAN", tagline: "Builder of things" };
export const FLOORS = [
  { n:1, id:"library",  label:"THE LIBRARY",  status:"open",  flash:"#e8b84b" },
  { n:2, id:"workshop", label:"THE WORKSHOP", status:"open",  flash:"#7ec8ff" },
  { n:3, id:"studio",   label:"THE STUDIO",   status:"open",  flash:"#ff9d6b" },
  { n:4, id:"garden",   label:"THE GARDEN",   status:"ghost", flash:"#7dd87d" },
  { n:5, id:"vault",    label:"THE VAULT",    status:"ghost", flash:"#b0bec9" },
  { n:6, id:"wip",      label:"",             status:"wip",   flash:"#ffb300" },
];
