export interface TaskRecord {
readonly id: string;
readonly state: "planned" | "running" | "completed";
readonly durationMs: number;
}

export function summarizeTasks(values: readonly TaskRecord[]): {
readonly total: number;
readonly completed: number;
readonly durationMs: number;
} {
let completed = 0;
let durationMs = 0;

for (const value of values) {
if (value.state === "completed") {
completed += 1;
}
durationMs += value.durationMs;
}

return {
total: values.length,
completed,
durationMs
};
}
