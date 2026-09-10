import { create } from "zustand";
import type { Architecture, SystemNode, Workload } from "./types";

interface EditorState {
  architecture: Architecture;
  workload: Workload;
  past: Architecture[];
  future: Architecture[];
  selectedId: string | null;
  revision: number;
  initialize: (architecture: Architecture, workload: Workload) => void;
  setArchitecture: (architecture: Architecture, record?: boolean) => void;
  updateNode: (id: string, patch: Partial<SystemNode>) => void;
  setWorkload: (patch: Partial<Workload>) => void;
  select: (id: string | null) => void;
  undo: () => void;
  redo: () => void;
}
export const useEditor = create<EditorState>((set) => ({
  architecture: { nodes: [], edges: [] },
  workload: { requestRate: 100, readRatio: 0.8, duration: 30, seed: 42, pattern: "steady", failure: "none" },
  past: [], future: [], selectedId: null, revision: 0,
  initialize: (architecture, workload) => set((state) => ({ architecture: structuredClone(architecture), workload: { ...workload }, past: [], future: [], selectedId: null, revision: state.revision + 1 })),
  setArchitecture: (architecture, record = true) => set((state) => ({ architecture, ...(record ? { past: [...state.past.slice(-29), state.architecture], future: [], revision: state.revision + 1 } : {}) })),
  updateNode: (id, patch) => set((state) => ({ architecture: { ...state.architecture, nodes: state.architecture.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }, past: [...state.past.slice(-29), state.architecture], future: [], revision: state.revision + 1 })),
  setWorkload: (patch) => set((state) => ({ workload: { ...state.workload, ...patch }, revision: state.revision + 1 })),
  select: (selectedId) => set({ selectedId }),
  undo: () => set((state) => state.past.length ? { architecture: state.past[state.past.length - 1], past: state.past.slice(0, -1), future: [state.architecture, ...state.future], revision: state.revision + 1 } : {}),
  redo: () => set((state) => state.future.length ? { architecture: state.future[0], future: state.future.slice(1), past: [...state.past, state.architecture], revision: state.revision + 1 } : {}),
}));
