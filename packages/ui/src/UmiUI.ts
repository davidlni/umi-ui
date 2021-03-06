import 'regenerator-runtime/runtime';
import assert from 'assert';
import emptyDir from 'empty-dir';
import express from 'express';
import http from 'http';
import compression from 'compression';

import sockjs from 'sockjs';
import { join, resolve, dirname, isAbsolute } from 'path';
import launchEditor from '@umijs/launch-editor';
import openBrowser from 'react-dev-utils/openBrowser';
import { existsSync, readFileSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { utils, Service } from 'umi';
import resolveFrom from 'resolve-from';

import indexRoute from './routes/index';
import commonRoute from './routes/common';
import resizeRoute from './routes/resize';

import Config from './Config';
import getClientScript, { getBasicScriptContent } from './getClientScript';
import listDirectory from './listDirectory';
import installCreator from './installCreator';
import { installDeps } from './npmClient';
import ActiveProjectError from './ActiveProjectError';
import { BackToHomeAction, OpenProjectAction, ReInstallDependencyAction } from './Actions';
import { isDepLost, isPluginLost, isUmiProject, isUsingBigfish, isUsingUmi } from './checkProject';
import isDepFileExists from './utils/isDepFileExists';
import initTerminal from './terminal';
import detectLanguage from './detectLanguage';
import detectNpmClients from './detectNpmClients';
import debug, { debugSocket } from './debug';

const { winPath, lodash, semver, portfinder, rimraf, chalk } = utils;
const { pick, uniq } = lodash;

export interface IContext {
  /** 是否打开浏览器 */
  browser: boolean;
  /** 完整版 */
  full: boolean;
  cwd: string;
  developMode: boolean;
  npmClients: string[];
  config: InstanceType<typeof Config>;
  basicUIPath: string;
  servicesByKey: any;
  logs: string[];
}

export default class UmiUI {
  cwd: string;
  servicesByKey: {
    [key: string]: Service;
  };
  ctx: Partial<IContext>;
  server: any;
  socketServer: any;
  logs: any;
  config: Config;
  send: any;
  developMode: boolean = false;
  npmClients: string[] = [];
  basicUIPath: string;
  basicConfigPath: string;

  constructor() {
    this.cwd = process.cwd();
    // 兼容旧版 Bigfish
    this.basicUIPath = process.env.BASIC_UI_PATH || '';
    // export default { serices, ... }
    this.basicConfigPath = process.env.BASIC_CONFIG_PATH || '';
    this.servicesByKey = {};
    this.server = null;
    this.socketServer = null;
    this.config = new Config({
      onSave: data => {
        if (this.send) {
          this.send({
            type: '@@project/list/progress',
            payload: data,
          });
        }
      },
    });
    this.npmClients = [];
    this.logs = [];
    this.ctx = {
      cwd: process.cwd(),
      developMode: !!process.env.DEVELOP_MODE,
      config: this.config,
      basicUIPath: this.basicUIPath,
      servicesByKey: this.servicesByKey,
      npmClients: this.npmClients,
      logs: this.logs,
    };
    this.developMode = !!process.env.DEVELOP_MODE;

    if (process.env.CURRENT_PROJECT) {
      const key = this.config.addProjectWithPath(join(process.cwd(), process.env.CURRENT_PROJECT));
      this.config.setCurrentProject(key);
    }

    process.nextTick(() => {
      this.initNpmClients();
    });
  }

  getService = cwd => {
    const serviceModule = process.env.BIGFISH_COMPAT
      ? '@alipay/bigfish/_Service.js'
      : 'umi/_Service.js';
    const servicePath = process.env.LOCAL_DEBUG
      ? 'umi/lib/cjs'
      : resolveFrom.silent(cwd, serviceModule) || 'umi/lib/cjs';
    debug(`Service path: ${servicePath}`);
    // eslint-disable-next-line import/no-dynamic-require
    const { Service: UmiService } = require(servicePath);
    const service = new UmiService({
      cwd,
    });
    return service;
  };

  async openProject(key: string, service?: any, opts?: any) {
    const { lang } = opts || {};
    const project = this.config.data.projectsByKey[key];
    assert(project, `project of key ${key} not exists`);

    // Check exists.
    if (!existsSync(project.path)) {
      throw new ActiveProjectError({
        title: {
          'zh-CN': `项目 ${project.path} 路径不存在。`,
          'en-US': `Project ${project.path} not exists.`,
        },
        lang,
        actions: [BackToHomeAction],
      });
    }

    // Check umi valid.
    if (!isUmiProject(project.path)) {
      throw new ActiveProjectError({
        title: {
          'zh-CN': `项目 ${project.path} 不是 Umi 项目。`,
          'en-US': `Project ${project.path} is not a valid Umi project.`,
        },
        lang,
        actions: [BackToHomeAction],
      });
    }

    if (process.env.BIGFISH_COMPAT && isUsingUmi(project.path)) {
      throw new ActiveProjectError({
        title: {
          'zh-CN': `项目 ${project.path} 是 Umi 项目，不能使用 Bigfish 打开。`,
          'en-US': `Project ${project.path} is Umi Project, don't open it with Bigfish.`,
        },
        lang,
        actions: [BackToHomeAction],
      });
    }

    if (!process.env.BIGFISH_COMPAT && isUsingBigfish(project.path)) {
      throw new ActiveProjectError({
        title: {
          'zh-CN': `项目 ${project.path} 是 Bigfish 项目，不能使用 Umi 打开。`,
          'en-US': `Project ${project.path} is Bigfish Project, don't open it with Umi.`,
        },
        lang,
        actions: [BackToHomeAction],
      });
    }

    if (!this.developMode && service) {
      this.servicesByKey[key] = service;
    } else if (!this.servicesByKey[key]) {
      // Attach Service
      debug(`Attach service for ${key}`);
      // Use local service and detect version compatibility
      const binModule = process.env.BIGFISH_COMPAT
        ? '@alipay/bigfish/bin/bigfish.js'
        : 'umi/bin/umi.js';
      const pkgModule = process.env.BIGFISH_COMPAT
        ? '@alipay/bigfish/package.json'
        : 'umi/package.json';
      const cwd = project.path;
      const localBin = isDepFileExists(cwd, binModule);
      if (process.env.UI_CHECK_LOCAL !== 'none' && localBin) {
        const { version } = JSON.parse(readFileSync(join(cwd, 'node_modules', pkgModule), 'utf-8'));
        if (!semver.gt(version, process.env.BIGFISH_COMPAT ? '3.0.0' : '3.0.0')) {
          throw new ActiveProjectError({
            title: process.env.BIGFISH_COMPAT
              ? `本地项目的 Bigfish 版本（${version}）过低，请升级到 @alipay/bigfish@3.0 或以上，<a target="_blank" href="https://yuque.antfin-inc.com/bigfish/doc/uzfwoc#ff1deb63">查看详情</a>。`
              : {
                  'zh-CN': `本地项目的 Umi 版本（${version}）过低，请升级到 umi@3.0 或以上，<a target="_blank" href="https://umijs.org/zh/guide/faq.html#umi-%E7%89%88%E6%9C%AC%E8%BF%87%E4%BD%8E%EF%BC%8C%E8%AF%B7%E5%8D%87%E7%BA%A7%E5%88%B0%E6%9C%80%E6%96%B0">查看详情</a>。`,
                  'en-US': `Umi version (${version}) of the project is too low, please upgrade to umi@2.12 or above, <a target="_blank" href="https://umijs.org/guide/faq.html#umi-version-is-too-low-please-upgrade-to-umi-2-9-or-above">view details</a>.`,
                },
            lang,
            actions: [ReInstallDependencyAction, OpenProjectAction, BackToHomeAction],
          });
        }
      }

      try {
        const currentService = this.getService(cwd);
        debug(`Attach service for ${key} after new and before init()`);
        await currentService.init();
        debug(`Attach service for ${key} ${chalk.green('SUCCESS')}`);
        this.servicesByKey[key] = currentService;
      } catch (e) {
        if (isDepLost(e) || isPluginLost(e)) {
          throw new ActiveProjectError({
            title: {
              'zh-CN': `依赖文件没找到。`,
              'en-US': 'Dependency file not found.',
            },
            message: e.message,
            stack: e.stack,
            lang,
            actions: [ReInstallDependencyAction, BackToHomeAction],
          });
        } else {
          throw new ActiveProjectError({
            title: {
              'zh-CN': '其他错误',
              'en-US': 'Other Errors',
            },
            message: e.message,
            stack: e.stack,
            lang,
            // exception tag
            exception: true,
            actions: [BackToHomeAction],
          });
        }
      }
    }

    this.config.editProject(key, {
      opened_at: +new Date(),
    });
  }

  async openProjectInEditor(
    key: string,
    callback: { failure?: (any) => void; success?: () => void } = {},
    lang: string = 'zh-CN',
  ) {
    let launchPath = key;
    if (!(key.startsWith('/') && existsSync(key))) {
      const project = this.config.data.projectsByKey[key];
      assert(project, `project of key ${key} not exists`);
      launchPath = project.path;
    }
    if (!existsSync(launchPath)) {
      if (callback.failure) {
        const msg = {
          'zh-CN': `打开编辑器失败 ${launchPath}，项目不存在`,
          'en-US': `Open Editor Failure, ${launchPath}, project does not exist`,
        };
        console.error(chalk.red(msg[lang]));
        callback.failure({
          message: msg[lang],
        });
      }
      if (callback.success) {
        callback.success();
      }
    } else {
      try {
        const res = await launchEditor(launchPath);
        if (res && res.success) {
          callback.success(res);
        } else {
          callback.failure(res);
        }
      } catch (e) {
        callback.failure(e);
      }
    }
  }

  async openConfigFileInEditor(projectPath: string, { success, failure, lang }) {
    let configFile;
    const configFiles = ['.umirc.js', '.umirc.ts', 'config/config.js', 'config/config.ts'];
    for (const file of configFiles) {
      if (existsSync(join(projectPath, file))) {
        configFile = join(projectPath, file);
        break;
      }
    }

    try {
      assert(
        configFile,
        lang === 'zh-CN'
          ? '在编辑器中打开失败，因为配置文件不存在。'
          : `Open failed with editor, since configFile not exists.`,
      );
      const res = await launchEditor(configFile);
      if (res && res.success) {
        success(res);
      } else {
        failure(res);
      }
    } catch (e) {
      console.error(e);
      failure({
        message: e.message,
      });
    }
  }

  async getExtraAssets({ key, success }) {
    const service = this.servicesByKey[key];
    const uiPlugins = await service.applyPlugins({
      key: 'addUIPlugin',
      type: service.ApplyPluginsType.add,
      initialValue: [],
    });
    debug('uiPlugins', uiPlugins);
    const script = getClientScript(uiPlugins);
    success({
      script,
    });
  }

  getBasicAssets() {
    const script = this.basicUIPath ? getBasicScriptContent(this.basicUIPath) : '';
    return {
      script,
    };
  }

  async installDeps(npmClient, projectPath, { onProgress, onSuccess, taobaoSpeedUp }) {
    await installDeps(npmClient, projectPath, {
      taobaoSpeedUp,
      onData(data) {
        onProgress({
          install: data,
        });
      },
    });
    onSuccess();
  }

  async createProject(opts = {}, { onSuccess, onFailure, onProgress, lang }) {
    let { key } = opts;
    let { retryFrom } = opts;

    let createOpts = opts;
    if (key) {
      assert('retryFrom' in opts, `key 和 retryFrom 必须同时提供。`);
      // eslint-disable-next-line prefer-destructuring
      createOpts = this.config.data.projectsByKey[key].createOpts;
    }

    const setProgress = args => {
      assert(key, `key is not initialized.`);
      this.config.setCreatingProgress(key, args);
    };

    const sigintHandler = () => {
      if (key) {
        this.config.setCreatingProgress(key, {
          stepStatus: 3,
          failure: {
            message: 'exit UmiUi server',
          },
        });
      }
      process.exit();
    };

    try {
      assert(createOpts.baseDir, `baseDir must be supplied`);
      assert(createOpts.name, `name must be supplied`);
      assert(createOpts.type, `type must be supplied`);
      const targetDir = join(createOpts.baseDir, createOpts.name);

      if (!retryFrom) {
        // 步骤：
        //
        // 1. 校验
        //      a) 比如检查目标目录是否为空或不存在
        // 2. 添加项目状态到本地存储，后面每一步都更新状态到存储
        // 3. 安装 create-umi 或更新他
        // 4. create-umi 创建
        //    如果是 ant-design-pro，还需要拆几步出来，比如 git clone
        // 5. 安装依赖
        //
        // 项目步骤：
        // 1. 校验参数
        // 2. 安装/更新 create-umi
        // 3. 使用 create-umi 初始化项目
        // 4. 安装依赖
        //
        // 结束后打开项目。

        // 0
        assert(
          !existsSync(targetDir) || emptyDir.sync(targetDir),
          `target dir ${targetDir} exists and not empty`,
        );

        // 1
        key = this.config.addProject({
          path: targetDir,
          name: createOpts.name,
          npmClient: createOpts.npmClient,
          createOpts,
        });

        // get create key
        onSuccess({
          key,
        });

        setProgress({
          // 表示第几个 step，从 0 开始
          step: 1,
          // 0: 未开始
          // 1: 执行中
          // 2: 执行完成
          // 3: 执行失败
          stepStatus: 0,
          steps: {
            'zh-CN': ['校验参数', '安装或更新 create-umi', '初始化项目', '安装依赖'],
            'en-US': [
              'Validate Params',
              'Install or Update create-umi',
              'Initialize Project',
              'Install Dependency',
            ],
          },
        });
      }

      // catch exit
      process.on('SIGINT', sigintHandler);

      // 1
      let creatorPath;
      // step 2 依赖 step 1
      if (retryFrom === 2) {
        retryFrom = 1;
      }
      if (!retryFrom || retryFrom <= 1) {
        setProgress({
          step: 1,
          stepStatus: 1,
        });
        creatorPath = await installCreator({
          // npmClient: createOpts.npmClient,
          onData(data) {
            onProgress({
              install: data,
            });
          },
        });
        setProgress({
          stepStatus: 2,
        });
      }

      // 2
      if (!retryFrom || retryFrom <= 2) {
        setProgress({
          step: 2,
          stepStatus: 1,
        });
        clearModule(creatorPath);
        await require(creatorPath).run({
          cwd: targetDir,
          type: createOpts.type || {},
          args: createOpts.args || {},
        });
        setProgress({
          stepStatus: 2,
        });
      }

      // 3
      if (!retryFrom || retryFrom <= 3) {
        setProgress({
          step: 3,
          stepStatus: 1,
        });
        // 重装 node_modules 时先清空，否则可能会失败
        if (retryFrom === 3) {
          rimraf.sync(join(targetDir, 'node_modules'));
        }
        await installDeps(createOpts.npmClient, targetDir, {
          taobaoSpeedUp: this.hasTaobaoSpeedUp(),
          onData(data) {
            onProgress({
              install: data,
            });
          },
        });
        setProgress({
          stepStatus: 2,
        });
        setProgress({
          success: true,
        });
      }
    } catch (e) {
      if (key) {
        this.config.setCreatingProgress(key, {
          stepStatus: 3,
          failure: e,
        });
      }
      onFailure(e);
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }
  }

  checkDirValid({ dir }, { onSuccess, onFailure }) {
    try {
      // 入参校验
      assert(dir, `payload.dir must be supplied`);

      if (!existsSync(dir)) {
        return onSuccess();
      }

      // 非目录判断和权限校验
      const stat = statSync(dir);
      assert(stat.isDirectory(), `target directory must be a directory`);

      // 费空目录判断
      assert(emptyDir.sync(dir), `target directory must be empty`);
    } catch (e) {
      onFailure(e);
    }
  }

  initNpmClients() {
    const ret = ['tnpm', 'cnpm', 'npm', 'ayarn', 'tyarn', 'yarn'].filter(npmClient => {
      try {
        execSync(`${npmClient} --version`, { stdio: 'ignore' });
        return true;
      } catch (e) {}
      return false;
    });
    debug('ret', ret);

    this.npmClients = ret;
  }

  getNpmClients() {
    return this.npmClients;
  }

  async getRouteComponents({ service }) {
    const routes = await service.getRoutes();

    const getComponents = routes =>
      routes.reduce((memo, route) => {
        if (route.component && !route.component.startsWith('()')) {
          const component = isAbsolute(route.component)
            ? route.component
            : require.resolve(join(this.cwd, route.component));
          memo.push(winPath(component));
        }
        if (route.routes) {
          memo = memo.concat(getComponents(route.routes));
        }
        return memo;
      }, []);

    return uniq(getComponents(routes));
  }

  async detectLanguage({ success, failure, key }) {
    const service = this.servicesByKey[key];
    try {
      const routeComponents = await this.getRouteComponents({
        service,
      });

      const language = detectLanguage(service.cwd, {
        routeComponents,
      });

      success({
        language,
      });
    } catch (e) {
      failure(e);
    }
  }

  // reloadProject(key: string) {}

  async handleCoreData({ type, payload, lang, key }, { log, send, success, failure, progress }) {
    switch (type) {
      case '@@project/getBasicAssets':
        success(this.getBasicAssets());
        break;
      case '@@project/getExtraAssets':
        this.getExtraAssets({
          key,
          success,
        });
        break;
      case '@@project/list':
        this.config.checkValid();
        this.config.load();
        success({
          data: this.config.data,
        });
        break;
      case '@@project/detail':
        success({
          data: this.config.data.projectsByKey[payload.key],
        });
        break;
      case '@@project/add':
        // TODO: 检验是否 umi 项目，不是则抛错给客户端
        try {
          assert(
            existsSync(payload.path),
            `Add project failed, since path ${payload.path} don't exists.`,
          );
          log('info', `Add project ${payload.path} with name ${payload.name}`);
          this.config.addProject({
            path: payload.path,
            name: payload.name,
          });
          success();
        } catch (e) {
          console.error(chalk.red(`Error: Add project FAILED`));
          console.error(e);
          failure({
            message: e.message,
          });
        }
        break;
      case '@@project/delete':
        if (this.config.data.projectsByKey[payload.key]) {
          log('info', `Delete project: ${this.getProjectName(payload.key)}`);
          this.config.deleteProject(payload.key);
          success();
        }
        break;
      case '@@project/getKeyOrAddWithPath':
        success({
          key: this.config.getKeyOrAddWithPath(payload.path),
        });
        break;
      case '@@project/open': {
        log('info', `Open project: ${this.getProjectName(payload.key)}`);
        try {
          await this.openProject(payload.key, null, {
            lang,
          });
          success();
        } catch (e) {
          failure(pick(e, ['title', 'message', 'stack', 'actions', 'exception']));
          console.error(chalk.red(`Error: Attach Project of key ${payload.key} FAILED`));
        }
        break;
      }
      case '@@project/openInEditor':
        log('info', `Open in editor: ${this.getProjectName(payload.key)}`);
        this.openProjectInEditor(
          payload.key,
          {
            success,
            failure,
          },
          lang,
        );
        break;
      case '@@project/edit':
        log('info', `Edit project: ${this.getProjectName(payload.key)}`);
        this.config.editProject(payload.key, {
          name: payload.name,
          cloudUrl: payload.cloudUrl,
        });
        success();
        break;
      case '@@project/setCurrentProject':
        this.config.load(); // 重新 load
        this.config.setCurrentProject(payload.key);
        success();
        break;
      case '@@project/clearCurrentProject':
        this.config.clearCurrentProject();
        success();
        break;
      case '@@project/create':
        log('info', `Create project: ${this.getProjectName(payload.key)}`);
        this.createProject(payload, {
          onSuccess: success,
          onFailure(e) {
            failure({
              message: e.message,
            });
          },
          onProgress: progress,
          lang,
        });
        break;
      case '@@project/checkDirValid':
        this.checkDirValid(payload, {
          onSuccess: success,
          onFailure(e) {
            failure({
              message: e.message,
            });
          },
        });
        break;
      case '@@project/createTemplateList':
        success({
          data: [
            {
              title: 'Ant Design Pro',
              description: 'A layout-only ant-design-pro boilerplate, use together with umi block',
              url: 'https://preview.pro.ant.design/',
            },
            {
              title: 'Basic Template',
              description: 'A simple boilerplate, support typescript.',
            },
          ],
        });
        break;
      case '@@project/getNpmClients':
        success({
          data: this.getNpmClients(),
        });
        break;
      case '@@project/getSharedDataDir':
        success({
          tmpDir: join(dirname(this.config.dbPath), 'shared-data', key),
        });
        break;
      case '@@project/detectLanguage':
        try {
          assert(key && this.servicesByKey[key], `Detect language failed, key must be supplied.`);
          this.detectLanguage({
            key,
            success,
            failure,
          });
        } catch (e) {
          console.error(e);
          failure({
            message: e.message,
          });
        }
        break;
      case '@@project/detectNpmClients':
        try {
          assert(key && this.servicesByKey[key], `Detect language failed, key must be supplied.`);
          const service = this.servicesByKey[key];
          success({
            npmClients: detectNpmClients(service.cwd),
          });
        } catch (e) {
          console.error(e);
          failure({
            message: e.message,
          });
        }
        break;
      case '@@fs/getCwd':
        success({
          cwd: this.cwd,
        });
        break;
      case '@@fs/listDirectory': {
        try {
          const data = listDirectory(payload.dirPath, {
            directoryOnly: true,
          });
          success({
            data,
          });
        } catch (e) {
          failure({
            message: e.message,
          });
        }
        break;
      }
      case '@@log/getHistory':
        success({
          data: this.logs,
        });
        break;
      case '@@log/clear':
        this.logs = [];
        success();
        break;
      case '@@actions/installDependencies':
        this.config.setProjectNpmClient({
          key: payload.key,
          npmClient: payload.npmClient,
        });
        this.installDeps(payload.npmClient, payload.projectPath, {
          taobaoSpeedUp: this.hasTaobaoSpeedUp(),
          onProgress: progress,
          onSuccess: success,
        });
        break;
      case '@@actions/reInstallDependencies':
        this.config.setProjectNpmClient({
          key: payload.key,
          npmClient: payload.npmClient,
        });
        rimraf.sync(join(payload.projectPath, 'node_modules'));
        this.installDeps(payload.npmClient, payload.projectPath, {
          taobaoSpeedUp: this.hasTaobaoSpeedUp(),
          onProgress: progress,
          onSuccess: success,
        });
        break;
      case '@@actions/openConfigFile':
        this.openConfigFileInEditor(payload.projectPath, {
          success,
          failure,
          lang,
        });
        break;
      case '@@actions/openProjectInEditor':
        this.openProjectInEditor(
          payload.projectPath,
          {
            success,
            failure,
          },
          lang,
        );
        break;
      case '@@app/notify':
        try {
          const notifier = require('node-notifier');
          const buildInImages = {
            error: winPath(resolve(__dirname, 'assets', 'error.png')),
            info: winPath(resolve(__dirname, 'assets', 'info.png')),
            success: winPath(resolve(__dirname, 'assets', 'success.png')),
            warning: winPath(resolve(__dirname, 'assets', 'warning.png')),
          };
          const { type, ...restPayload } = payload;
          const noticeConfig = {
            ...restPayload,
            contentImage: buildInImages[type] || buildInImages.info,
            icon: winPath(resolve(__dirname, 'assets', 'umi.png')),
            sound: true,
          };
          notifier.notify(noticeConfig);
          success();
        } catch (e) {
          console.error(chalk.red(`Error: Notify for ${e.message} FAILED`));
          failure(e);
        }
        break;
      default:
        // log('error', chalk.red(`Unhandled message type ${type}`));
        // failure();
        break;
    }
  }

  async start(
    opts?: Pick<IContext, 'browser' | 'full'>,
  ): Promise<{ server: http.Server; port: string | number }> {
    const { browser, full = false } = opts || {};
    this.ctx.full = full;
    this.ctx.browser = browser;

    return new Promise(async (resolve, reject) => {
      console.log(`🚀 Starting Umi UI using umi@${process.env.UMI_VERSION}...`);

      const app = express();
      app.use(compression());
      // Serve Static (Production Only)
      if (!process.env.LOCAL_DEBUG) {
        app.use(
          express.static(join(__dirname, '..', 'web/dist'), {
            index: false,
          }),
        );
      }
      /**
       * Terminal shell resize server
       */
      app.get('/terminal/resize', resizeRoute(this.ctx));
      // 访问域名打开
      app.get('/', indexRoute(this.ctx));
      app.use('/*', commonRoute(this.ctx));

      const ss = sockjs.createServer();

      const conns = {};
      function send(action) {
        const message = JSON.stringify(action);
        debugSocket(chalk.green.bold('>>>>'), formatLogMessage(message));
        Object.keys(conns).forEach(id => {
          conns[id].write(message);
        });
      }

      function formatLogMessage(message) {
        let ret = message.length > 500 ? `${message.slice(0, 500)} ${chalk.gray('...')}` : message;
        ret = ret.replace(/{"type":"(.+?)"/, `{"type":"${chalk.magenta.bold('$1')}"`);
        return ret;
      }

      ss.on('connection', conn => {
        if (!conn) {
          return;
        }
        conns[conn.id] = conn;
        debugSocket(`🔗 ${chalk.green('Connected to')}: ${conn.id}`);
        function success(type, payload) {
          send({ type: `${type}/success`, payload });
        }
        function failure(type, payload) {
          send({ type: `${type}/failure`, payload });
        }
        function progress(type, payload) {
          send({ type: `${type}/progress`, payload });
        }

        this.send = send;
        // 给 packages/umi/src/scripts/dev.js 用
        global.g_send = send;

        const log = (type, message) => {
          const payload = {
            date: +new Date(),
            type,
            message,
          };
          const msg = `${chalk.gray(`[${type}]`)} ${message}`;
          const logFunc = type === 'error' ? console.error : debugSocket;
          logFunc(msg);
          this.logs.push(payload);
          send({
            type: '@@log/message',
            payload,
          });
        };

        conn.on('close', () => {
          debugSocket(`😿 ${chalk.red('Disconnected to')}: ${conn.id}`);
          delete conns[conn.id];
        });
        conn.on('data', async message => {
          try {
            const { type, payload, $lang: lang, $key: key } = JSON.parse(message);
            debugSocket(chalk.blue.bold('<<<<'), formatLogMessage(message));
            const serviceArgs = {
              action: { type, payload, lang },
              log,
              send,
              success: success.bind(this, type),
              failure: failure.bind(this, type),
              progress: progress.bind(this, type),
            };

            // Bigfish extend service
            if (this.basicConfigPath) {
              const { services } =
                // eslint-disable-next-line import/no-dynamic-require
                require(this.basicConfigPath).default || require(this.basicConfigPath) || [];
              if (services?.length > 0) {
                // register framework services
                services.forEach(baseUIService => {
                  baseUIService(serviceArgs);
                });
              }
            }

            if (type.startsWith('@@')) {
              await this.handleCoreData(
                { type, payload, lang, key },
                {
                  log,
                  send,
                  success: success.bind(this, type),
                  failure: failure.bind(this, type),
                  progress: progress.bind(this, type),
                },
              );
            } else {
              assert(this.servicesByKey[key], `service of key ${key} not exists.`);
              const service = this.servicesByKey[key];
              await service.applyPlugins({
                key: 'onUISocket',
                type: service.ApplyPluginsType.event,
                args: serviceArgs,
              });
            }
            // eslint-disable-next-line no-empty
          } catch (e) {
            console.error(chalk.red(e.stack));
          }
        });
      });

      const port = await portfinder.getPortPromise({
        port: process.env.UMI_UI_PORT || process.env.UMI_PORT || 3000,
      });
      const server = app.listen(port, process.env.HOST || '127.0.0.1', err => {
        if (err) {
          reject(err);
        } else {
          const [command] = process.argv.slice(2);
          const url = `http://localhost:${port}/`;
          console.log(
            command === 'dev' ? `🌈 Umi UI mini Ready on port 3000.` : `⛽️ Ready on ${url}.`,
          );
          if (browser) {
            openBrowser(url);
          }
          resolve({
            port,
            server: this.server,
          });
          // just TEST or ALL ?
          if (process.send) {
            const message = {
              type: 'UI_SERVER_DONE',
              data: {
                port,
                url,
              },
            };
            debug(`send ${JSON.stringify(message)}`);
            process.send(message);
          }
        }
      });
      ss.installHandlers(server, {
        prefix: '/umiui',
        log: () => {},
      });
      initTerminal.call(this, server);
      this.socketServer = ss;
      this.server = server;
    });
  }

  /**
   * 返回 projcet name，如果 project 不存在，则返回 key
   * @param key project key
   */
  getProjectName(key: string): string {
    if (!key) {
      return '';
    }
    const project = this.config.data.projectsByKey[key];
    if (!project) {
      return key;
    }
    return project.name;
  }

  /**
   * 是否使用淘宝加速
   * @param key project key
   */
  hasTaobaoSpeedUp(): boolean {
    // 一期默认开启，二期走全局配置。
    return true;
  }
}
