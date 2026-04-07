export interface Organization {
  id: string;
  name: string;
  apiKey: string;
  adminKey: string;
  isActive: boolean;
}

export interface KaiFilters {
  domains: string[];
  topics: string[];
  knowledgeTypes: string[];
}

export interface TenantContext {
  organizationId: string;
  isAuthenticated: boolean;
  isAdmin: boolean;
  kaiId?: string;
  kaiFilters?: KaiFilters;
}
