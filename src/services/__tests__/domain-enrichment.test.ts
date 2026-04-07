import { describe, it, expect } from 'vitest';
import { enrichDomains } from '../connectors/domain-enrichment.js';

describe('enrichDomains', () => {
  it('adds genai for cortex content', () => {
    const result = enrichDomains(
      'Building an AI Agent with Snowflake Cortex',
      'This tutorial shows how to use Cortex AI functions...',
      ['snowflake', 'data-engineering'],
    );
    expect(result).toContain('genai');
    expect(result).toContain('snowflake');
    expect(result).toContain('data-engineering');
  });

  it('adds genai for LLM content', () => {
    const result = enrichDomains(
      'Fine-tuning a Large Language Model',
      'Step by step guide to fine-tuning LLMs on Databricks...',
      ['databricks'],
    );
    expect(result).toContain('genai');
  });

  it('adds machine-learning for MLflow content', () => {
    const result = enrichDomains(
      'Tracking Experiments with MLflow',
      'MLflow provides experiment tracking and model registry...',
      ['databricks'],
    );
    expect(result).toContain('machine-learning');
  });

  it('adds streaming for kinesis content', () => {
    const result = enrichDomains(
      'Real-time Data Processing',
      'Using Amazon Kinesis for streaming data pipelines...',
      ['aws', 'data-engineering'],
    );
    expect(result).toContain('streaming');
  });

  it('does not duplicate existing domains', () => {
    const result = enrichDomains(
      'Cortex AI Functions',
      'Some content...',
      ['snowflake', 'genai'],
    );
    const genaiCount = result.filter(d => d === 'genai').length;
    expect(genaiCount).toBe(1);
  });

  it('returns original domains when no keywords match', () => {
    const result = enrichDomains(
      'Setting Up Your Data Warehouse',
      'Create tables and load data using COPY command...',
      ['aws', 'redshift'],
    );
    expect(result).toEqual(['aws', 'redshift']);
  });

  it('adds security for access control content', () => {
    const result = enrichDomains(
      'Configuring IAM Roles for Authentication',
      'Set up identity management and access control policies...',
      ['aws'],
    );
    expect(result).toContain('security');
  });

  it('adds data-governance for unity catalog content', () => {
    const result = enrichDomains(
      'Data Lineage Tracking',
      'Unity Catalog provides data governance and lineage...',
      ['databricks'],
    );
    expect(result).toContain('data-governance');
  });

  it('only checks first 2000 chars of content for performance', () => {
    const longContent = 'x'.repeat(3000) + ' cortex ai functions';
    const result = enrichDomains('Plain Title', longContent, ['snowflake']);
    // Keyword is past 2000 chars, should not match
    expect(result).not.toContain('genai');
  });
});
