import fs from 'fs';
import path from 'path';
import { Octokit } from '@octokit/rest';
import * as github from '@actions/github';

export function logger(level, message, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, ...args);
}

export function handleError(error, context) {
  if (error.response) {
    logger('error', `${context}: ${error.response.status} - ${error.response.statusText} - ${JSON.stringify(error.response.data)}`);
  } else if (error.request) {
    logger('error', `${context}: No response received`);
  } else {
    logger('error', `${context}: ${error.message}`);
  }
}

export function writeJsonToFile(filePath, data) {
  try {
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    handleError(error, `Error writing to file ${filePath}`);
    return false;
  }
}

export async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export class ConcurrencyPool {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
  }

  async add(fn) {
    if (this.running >= this.maxConcurrency) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

export class IssueManager {
  constructor(token) {
    this.octokit = new Octokit({
      auth: token
    });
  }

  async getIssues(exclude_labels) {
    const { owner, repo } = github.context.repo;
    
    try {
      // 使用 paginate 方法一次性获取所有 issues
      const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
        owner,
        repo,
        state: 'open',
        per_page: 100,
        sort: 'created',
        direction: 'desc'
      });
      logger('info', `Fetched ${issues.length} issues`, issues.map(item => item.number).join(','));
      // 过滤掉包含 exclude_labels 中定义的标签的 Issue
      const filteredIssues = issues.filter(issue => {
        const issueLabels = issue.labels.map(label => label.name);
        return !exclude_labels.some(excludeLabel => issueLabels.includes(excludeLabel));
      });
      
      logger('info', `Filtered(${exclude_labels}) ${issues.length}`, filteredIssues.map(item => item.number).join(','));
      return filteredIssues.map(issue => ({
        url: issue.body?.match(/"url":\s*"([^"]+)"/)?.at(1),
        number: issue.number,
        labels: issue.labels.map(label => ({
          name: label.name,
          color: label.color
        })),
        body: issue.body
      })).filter(item => item.url);
    } catch (error) {
      handleError(error, 'Error fetching issues');
      throw error;
    }
  }

  async updateIssueLabels(issueNumber, labels) {
    // 如果 labels 里面有未定义对象，就移除
    labels = (labels || []).filter(label => label);
    const { owner, repo } = github.context.repo;
    try {
      logger('info', `Will update labels for issue #${issueNumber} at ${owner}/${repo}`, labels);
      await this.octokit.issues.setLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels
      });
      logger('info', `Updated labels for issue #${issueNumber}`, labels);
    } catch (error) {
      handleError(error, `Error updating labels for issue #${issueNumber}`);
    }
  }
}