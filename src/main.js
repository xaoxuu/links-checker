import * as core from '@actions/core';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger, handleError, withRetry, ConcurrencyPool, IssueManager } from './utils.js';

const config = {
  // 
  checker: core.getInput('checker') || 'friend',
  retry_times: parseInt(core.getInput('retry_times') || 3),
  exclude_issue_with_labels: (core.getInput('exclude_issue_with_labels') || '审核中, 白名单').split(',').map(s => s.trim()),
  // 站点检查设置
  // 定义常量
  MAX_CONCURRENT_REQUESTS: 5,
  REQUEST_DELAY_MIN: 1000,
  REQUEST_DELAY_MAX: 3000,
  REQUEST_USER_AGENTS: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  ],
  REQUEST_HEADERS: {},
  REQUEST_TIMEOUT: 10000,

  accepted_codes: core.getInput('accepted_codes') || '200,301',

  unreachable_label: core.getInput('unreachable_label') || '无法访问',
  theme_checker_invalid_label: core.getInput('theme_checker_invalid_label') || '无效主题',
  friend_checker_invalid_label: core.getInput('friend_checker_invalid_label') || '未添加友链',
  
  theme_checker_meta_tag: core.getInput('theme_checker_meta_tag') || 'meta[theme-name="Stellar"]',
  theme_checker_content_attr: core.getInput('theme_checker_content_attr') || 'content',
  theme_checker_version_attr: core.getInput('theme_checker_version_attr') || 'theme-version',
};

async function checkSite(item) {
  const url = item.url;
  var checkResult = { valid: false };
  try {
    // 随机选择延时时间
    const delay = Math.floor(Math.random() * (config.REQUEST_DELAY_MAX - config.REQUEST_DELAY_MIN)) + config.REQUEST_DELAY_MIN;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // 随机选择 User-Agent
    const randomUserAgent = config.REQUEST_USER_AGENTS[Math.floor(Math.random() * config.REQUEST_USER_AGENTS.length)];
    
    // 构建请求头
    const requestHeadersWithUA = {
      'User-Agent': randomUserAgent,
      ...config.REQUEST_HEADERS
    };
    
    const response = await axios.get(url, {
      timeout: config.REQUEST_TIMEOUT,
      headers: requestHeadersWithUA,
      validateStatus: status => status < 500 // 允许除500以外的状态码
    });

    checkResult.status = response.status;
    checkResult.reachability = config.accepted_codes.includes(response.status.toString());

    if (config.checker === 'theme') {
      const $ = cheerio.load(response.data);
      
      // 兼容volantis主题（请尽快过渡到通用格式）
      if (config.theme_checker_meta_tag == 'volantis') {
        logger('info', `#${item.number} Checking site: ${url} (Volantis theme)`);
        // 满足 <head hexo-theme="https://github.com/volantis-x/hexo-theme-volantis/#6.0.0-alpha.0"> 这种格式的主题就是 volantis 主题
        // 提取 head 标签中的 hexo-theme 属性
        const volantisURL = $('head').attr('hexo-theme');
        if (!volantisURL || !volantisURL.includes('/volantis-x/hexo-theme-volantis/')) {
          logger('info', `#${item.number} volantisURL not found`);
          checkResult.valid = false;
          return checkResult;
        }
        
        // 提取版本号
        const volantisVersion = volantisURL.match(/\/#([\d.]+(?:-[\w.]+)?)/)?.[1];
        if (volantisVersion) {
          checkResult.valid = true;
          checkResult.themeName = 'Volantis';
          checkResult.themeVersion = volantisVersion;
        } else {
          checkResult.valid = false;
        }
        
        return checkResult;
      }
      
      // 主题检查器
      const themeMetaTag = $(config.theme_checker_meta_tag);
      
      // <meta name="hexo-theme" content="url" theme-name="Stellar" theme-version="1.30.0">
      // 通用的版本号匹配函数
      const extractVersionFromURL = (content) => {
        if (!content) return null;
        // 匹配 URL 路径中的版本号
        const urlVersionMatch = content.match(/\/tree\/([\d.]+(?:-[\w.]+)?)/)?.[1];
        if (urlVersionMatch) return urlVersionMatch;
        // 匹配直接的版本号格式
        const directVersionMatch = content.match(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)?.[0];
        return directVersionMatch || null;
      };
      
      if (themeMetaTag.length > 0) {
        const theme_checker_content_attr = config.theme_checker_content_attr;
        const theme_checker_version_attr = config.theme_checker_version_attr;
        const content = themeMetaTag.attr(theme_checker_content_attr);
        const themeVersion = themeMetaTag.attr(theme_checker_version_attr) || extractVersionFromURL(content);
        if (content && themeVersion) {
          checkResult.valid = true;
          checkResult.themeName = themeMetaTag.attr('theme-name');
          checkResult.themeVersion = themeVersion;
          return checkResult;
        }
      }
      // 主题检查器结果：无效
      checkResult.valid = false;
    } else {
      // 友链检查器（目前仅检查网站是否正常访问）
      checkResult.valid = checkResult.reachability;
      // TODO: 静态友链检查网页内容是否包含目标友链信息，动态友链检查输出json是否包含目标友链信息
    }
    
  } catch (error) {
    // 针对特定错误类型进行处理
    if (error.response) {
      if (error.response.status === 403) {
        logger('warn', `Access forbidden for site ${url}, possibly due to anti-crawling measures`);
      } else if (error.response.status === 429) {
        logger('warn', `Rate limited for site ${url}, will retry later`);
      }
      checkResult.status = error.response.status;
    }
    handleError(error, `#${item.number} Error checking site ${url}`);
    checkResult.valid = false;
    checkResult.reachability = false;
  }
  return checkResult;
}

async function processData() {

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const issueManager = new IssueManager(githubToken);
    const validSites = await issueManager.getIssues(config.exclude_issue_with_labels);
    logger('info', `Total sites to check: ${validSites.length}`);
    let errors = [];
    
    // 创建并发控制池
    const pool = new ConcurrencyPool(config.MAX_CONCURRENT_REQUESTS);
    const checkPromises = validSites.map(item => {
      return pool.add(async () => {
        try {
          const url = item.body?.match(/"url":\s*"([^"]+)"/)?.at(1);
          item.url = url;
          if (!url) {
            logger('warn', `#${item.number} No url found in issue body`);
            return;
          }
          logger('info', `#${item.number} Checking site: ${url}`);
          const checkSiteWithRetry = () => checkSite(item);
          const checkResult = await withRetry(checkSiteWithRetry, config.retry_times);
          logger('info', `#${item.number} Checked site: ${url} checkResult: ${JSON.stringify(checkResult)}`);
          let labels = item.labels.map(label => label.name);
          if (checkResult.status === 200) {
            // 如果状态码为200，就移除所有status:开头的标签
            labels = labels.filter(label => !label.startsWith('status:'));
          } else if (checkResult.status) {
            // 否则，添加status:开头的标签
            labels = [...labels, `status:${checkResult.status}`];
          }
          if (checkResult.themeVersion) {
            // 先移除所有语义话版本号标签
            labels = labels.filter(label =>!label.match(/^v?[\d.]+(?:-[\w.]+)?$/));
            // 添加标签主题版本号
            labels = [...labels, `v${checkResult.themeVersion}`];
          }
          if (checkResult.reachability === true) {
            // 移除所有无法访问的标签
            labels = labels.filter(label => label !== config.unreachable_label);
            if (checkResult.valid) {
              // 移除所有检查结果为invalid的标签
              if (config.checker === 'theme') {
                labels = labels.filter(label => label !== config.theme_checker_invalid_label);
              } else {
                labels = labels.filter(label => label !== config.friend_checker_invalid_label);
              }
            } else {
              // 如果检查结果无效，添加无法访问标签
              if (config.checker === 'theme') {
                labels = [...labels, config.theme_checker_invalid_label];
              } else {
                labels = [...labels, config.friend_checker_invalid_label];
              }
            }
          } else {
            // 无法访问的网站添加无法访问标签
            labels = [...labels, config.unreachable_label];
          }
          // 去重
          labels = [...new Set(labels)];
          logger('info', `#${item.number} Updating labels: '${labels.join(', ')}', labels: ${labels}`);
          await issueManager.updateIssueLabels(item.number, labels);
          logger('info', `Finished checking site for issue #${item.number}, checkResult: ${JSON.stringify(checkResult)}`);
        } catch (error) {
          errors.push({ issue: item.number, error: error.message });
          logger('error', `#${item.number} Error processing site ${error.message}`);
        }
      });
    });

    // 等待所有检查任务完成
    await Promise.all(checkPromises);

    if (errors.length > 0) {
      logger('warn', `Completed with ${errors.length} errors:`);
      errors.forEach(err => {
        logger('warn', `Issue #${err.issue} (${err.url}): ${err.error}`);
      });
      process.exit(1);
    }
  } catch (error) {
    handleError(error, 'Error processing data');
    process.exit(1);
  }
}

processData();