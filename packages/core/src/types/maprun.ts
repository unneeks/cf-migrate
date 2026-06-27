export type MappingStatus = 'mapped' | 'fallback' | 'manual_review';
export type MappingConfidence = 'high' | 'medium' | 'low';

export interface MapRunStats {
  mapped: number;
  fallback: number;
  manual_review: number;
}

export interface MapRunMeta {
  pipeline_name: string;
  pipeline_id: string;
  project: string;
  source_file: string;
  mapping_source: string;
  target_workflow: string;
  generated_at: string;
  total_steps: number;
  stats: MapRunStats;
}

export interface MapRunMapping {
  seq: number;
  cf_step: string;
  cf_type: string;
  cf_stage: string;
  cf_title: string;
  gha_job: string;
  gha_step: string;
  rule_id: string;
  action: string;
  status: MappingStatus;
  confidence: MappingConfidence;
  pattern_matched: string | null;
  rationale: string;
}

export interface MapRunFile {
  version: string;
  meta: MapRunMeta;
  mappings: MapRunMapping[];
}
