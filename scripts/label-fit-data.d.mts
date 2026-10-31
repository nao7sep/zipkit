interface Headed {
  format: { owner: string; kind: string; version: number };
  writer: { name: string; version: string };
}
export declare const LABEL_FIT_LAYOUT: Headed & { layout: { jobsWidth: number; statusWidth: number; recordsListWidth: number } };
export declare function labelFitConfig(language: string): Headed & { language: string; theme: "light" };
export declare function labelFitQueue(input: string): Headed & { jobs: { id: string; inputs: string[]; options: Record<string, never> }[] };
