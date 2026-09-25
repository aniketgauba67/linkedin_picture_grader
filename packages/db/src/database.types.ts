/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate after every migration with `pnpm --filter @pps/db gen:types`,
 * or `pnpm --filter @pps/db gen:types:pg` on a machine without Docker.
 * Checked in on purpose so a clone can typecheck without a database.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      assessments: {
        Row: {
          id: string;
          photo_id: string;
          source: string;
          axes: Json;
          model: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          photo_id: string;
          source: string;
          axes: Json;
          model?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          photo_id?: string;
          source?: string;
          axes?: Json;
          model?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'assessments_photo_id_fkey';
            columns: ['photo_id'];
            isOneToOne: false;
            referencedRelation: 'photos';
            referencedColumns: ['id'];
          },
        ];
      };
      extraction_claims: {
        Row: {
          sha256: string;
          extractor_version: string;
          owner_photo_id: string;
          claim_token: string;
          claimed_at: string;
        };
        Insert: {
          sha256: string;
          extractor_version: string;
          owner_photo_id: string;
          claim_token: string;
          claimed_at: string;
        };
        Update: {
          sha256?: string;
          extractor_version?: string;
          owner_photo_id?: string;
          claim_token?: string;
          claimed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'extraction_claims_owner_photo_id_fkey';
            columns: ['owner_photo_id'];
            isOneToOne: false;
            referencedRelation: 'photos';
            referencedColumns: ['id'];
          },
        ];
      };
      feature_cache: {
        Row: {
          sha256: string;
          extractor_version: string;
          computed: Json;
          clip_embedding: string | null;
          extracted_at: string;
        };
        Insert: {
          sha256: string;
          extractor_version: string;
          computed: Json;
          clip_embedding?: string | null;
          extracted_at?: string;
        };
        Update: {
          sha256?: string;
          extractor_version?: string;
          computed?: Json;
          clip_embedding?: string | null;
          extracted_at?: string;
        };
        Relationships: [];
      };
      features: {
        Row: {
          photo_id: string;
          computed: Json;
          clip_embedding: string | null;
          extracted_at: string;
          extractor_version: string;
        };
        Insert: {
          photo_id: string;
          computed: Json;
          clip_embedding?: string | null;
          extracted_at?: string;
          extractor_version: string;
        };
        Update: {
          photo_id?: string;
          computed?: Json;
          clip_embedding?: string | null;
          extracted_at?: string;
          extractor_version?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'features_photo_id_fkey';
            columns: ['photo_id'];
            isOneToOne: false;
            referencedRelation: 'photos';
            referencedColumns: ['id'];
          },
        ];
      };
      photos: {
        Row: {
          id: string;
          storage_path: string | null;
          uploaded_by: string | null;
          sha256: string | null;
          created_at: string;
          expires_at: string;
          deleted_at: string | null;
          extraction_started_at: string | null;
        };
        Insert: {
          id?: string;
          storage_path?: string | null;
          uploaded_by?: string | null;
          sha256?: string | null;
          created_at?: string;
          expires_at?: string;
          deleted_at?: string | null;
          extraction_started_at?: string | null;
        };
        Update: {
          id?: string;
          storage_path?: string | null;
          uploaded_by?: string | null;
          sha256?: string | null;
          created_at?: string;
          expires_at?: string;
          deleted_at?: string | null;
          extraction_started_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'photos_uploaded_by_fkey';
            columns: ['uploaded_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      rate_limit_counters: {
        Row: {
          scope: string;
          subject: string;
          count: number;
          reset_at: string;
        };
        Insert: {
          scope: string;
          subject: string;
          count: number;
          reset_at: string;
        };
        Update: {
          scope?: string;
          subject?: string;
          count?: number;
          reset_at?: string;
        };
        Relationships: [];
      };
      scores: {
        Row: {
          id: string;
          photo_id: string;
          context: string;
          score: number;
          axis_scores: Json;
          weights_version: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          photo_id: string;
          context: string;
          score: number;
          axis_scores: Json;
          weights_version: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          photo_id?: string;
          context?: string;
          score?: number;
          axis_scores?: Json;
          weights_version?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scores_photo_id_fkey';
            columns: ['photo_id'];
            isOneToOne: false;
            referencedRelation: 'photos';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      claim_extraction: {
        Args: {
          p_photo_id: string | null;
          p_sha256: string | null;
          p_extractor_version: string | null;
          p_stale_after?: string | null;
        };
        Returns: string;
      };
      consume_rate_limit: {
        Args: {
          p_ip_hash: string | null;
          p_per_ip_limit: number | null;
          p_global_limit: number | null;
          p_window_seconds: number | null;
        };
        Returns: Json;
      };
      delete_photo: {
        Args: {
          p_photo_id: string | null;
        };
        Returns: boolean;
      };
      expire_photos: {
        Args: {
          p_limit?: number | null;
        };
        Returns: number;
      };
      mark_storage_reclaimed: {
        Args: {
          p_photo_ids: string[] | null;
        };
        Returns: number;
      };
      prune_feature_cache: {
        Args: {
          p_keep_version: string | null;
        };
        Returns: number;
      };
      prune_rate_limit_counters: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      record_extraction: {
        Args: {
          p_photo_id: string | null;
          p_sha256: string | null;
          p_computed: Json | null;
          p_extractor_version: string | null;
          p_embedding?: string | null;
        };
        Returns: undefined;
      };
      release_extraction: {
        Args: {
          p_sha256: string | null;
          p_extractor_version: string | null;
          p_claim_token: string | null;
        };
        Returns: undefined;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type Inserts<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type Updates<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
