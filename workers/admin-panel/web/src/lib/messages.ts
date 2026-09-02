/**
 * 界面文案，集中一处。
 *
 * 当前只有 zh-CN，但组件一律从这里取字符串，所以加语言时改的是这个文件而不是
 * 二十个组件。函数形式的条目是需要插值的那些 —— 模板串拼在组件里就等于把文案
 * 又散回去了。
 *
 * 语气规则（PRODUCT.md 的品牌承诺）：说清后果，不吓人。空状态是"还没开始"，
 * 不是"配置有错"。危险开关不禁止，只让手指变重。
 */
export const t = {
  app: {
    name: 'jouska',
    title: 'jouska 管理面板',
    subtitle: '反向代理配置',
  },

  nav: {
    routes: '路由',
    domains: '域名',
    preview: '发布',
    audit: '审计',
    users: '用户',
    history: '历史',
    mcp: 'MCP 令牌',
    menu: '导航菜单',
    skipToContent: '跳到主内容',
  },

  theme: {
    label: '主题',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
    /** 快捷键提示；按键本身用 Kbd 渲染，这里只有它后面的说明。 */
    shortcutKey: 'D',
    shortcutHint: '快速切换深浅',
  },

  account: {
    admin: '管理员',
    viewer: '观察者',
    viewerReadonly: '观察者身份，只读',
    logout: '退出登录',
    menu: '账号菜单',
    changePassword: '修改密码…',
  },

  /**
   * 修改自己的密码。当前会话保留（服务端只吊销其他会话），所以成功后的下一句话
   * 是「其他标签页要重新登录」而不是「请重新登录」—— 这个区别是真实的安全承诺，
   * 措辞不能含糊。
   */
  changePassword: {
    title: '修改密码',
    lead: '改完之后，其他标签页和其他设备的登录会失效，当前这一页不受影响。',
    current: '当前密码',
    new: '新密码',
    confirm: '再输一遍新密码',
    mismatch: '两次输入的新密码不一样',
    action: '确认修改',
    pending: '修改中…',
    ok: '密码已修改，其他标签页需要重新登录。',
    errors: {
      wrong_password: '当前密码不对。',
      no_password: '这个账号不是用密码登录的（比如走了 SSO），改不了密码。',
      locked: (minutes: number) => `试错太多次，账号已锁定，${minutes} 分钟后再试。`,
      invalid_input: (min: number, max: number) => `新密码需要 ${min}-${max} 位。`,
      unknown: (message: string) => `修改失败：${message}`,
    },
  },

  /**
   * 用户管理页。角色与状态徽章的措辞与顶栏一致（管理员/观察者）；停用与锁定是
   * 两种不同的病：前者是人的决定，后者是服务的保护，图标与文案都不共用。
   */
  users: {
    title: '用户',
    description: '账号、角色与会话。停用是可逆的，删除不可逆。',
    refresh: '刷新',
    create: '新建用户',
    columns: {
      subject: '账号',
      role: '角色',
      status: '状态',
      sessions: '会话',
      createdAt: '创建时间',
      lastSeen: '最后登录',
      actions: '操作',
    },
    status: {
      normal: '正常',
      disabled: '已停用',
      locked: '已锁定',
      lockedUntil: (when: string) => `锁定至 ${when}`,
      never: '从未登录',
    },
    roleAdmin: '管理员',
    roleViewer: '观察者',
    selfNote: '这是你自己的账号',
    createTitle: '新建用户',
    createDescription: '密码请通过安全渠道交给对方；对方首次登录后可自行修改。',
    editTitle: (subject: string) => `编辑用户 ${subject}`,
    editRole: '角色',
    editRoleHint: '降级最后一个可用管理员会被拒绝 —— 面板需要至少一个能开门的人。',
    editDisabled: '停用这个账号',
    editDisabledHint: '停用后无法登录，已有会话立刻失效；可以随时恢复。',
    unlock: '解除锁定',
    unlockHint: '清除失败计数并立即解锁。',
    save: '保存修改',
    rowMenu: (subject: string) => `${subject} 的操作`,
    edit: '编辑',
    remove: '删除',
    deleteTitle: (subject: string) => `删除用户 ${subject}？`,
    deleteBody: '立即生效：会话全部作废，账号不可恢复。最后一个用户不可删除。',
    deleteSelfNote: '这是你自己的账号。删除后你会立刻退出。',
    confirm: '删除',
    created: (subject: string) => `${subject} 已创建，密码请通过安全渠道交给对方。`,
    updated: (subject: string) => `${subject} 已更新`,
    deleted: (subject: string) => `${subject} 已删除`,
    unlocked: (subject: string) => `${subject} 已解锁`,
    errors: {
      subject_taken: '这个账号名已经有人用了。',
      last_admin: '面板需要至少一个可用的管理员，这个改动被拒绝。',
      last_user: '至少要保留一个用户 —— 删空会重新打开首次部署入口。',
      not_found: '这个用户已经不存在了，刷新一下列表。',
      forbidden: '这个操作需要管理员权限。',
      invalid_input: '输入不合法：账号 1-128 字符，密码 12-1024 位，角色是 admin 或 viewer。',
      no_password: '这个账号不是用密码登录的（比如走了 SSO）。',
      unknown: (message: string) => `操作失败：${message}`,
    },
    loadFailed: (message: string) => `加载用户列表失败：${message}`,
    empty: {
      title: '没有其他用户',
      description: '新建一个用户，把账号和密码通过安全渠道交给对方。',
    },
  },

  auth: {
    loginTitle: '登录',
    loginAction: '登录',
    loginPending: '登录中…',
    bootstrapTitle: '首次部署',
    bootstrapLead: '数据库里还没有账号。创建第一个管理员，之后这个入口会永久关闭。',
    bootstrapAction: '创建管理员并登录',
    bootstrapPending: '创建中…',
    toBootstrap: '首次部署？创建管理员账号',
    toLogin: '已经有账号了，去登录',
    subject: '账号',
    password: '密码',
    passwordHint: (min: number) => `至少 ${min} 位`,
    bootstrapOk: '管理员已创建，正在登录…',
    errors: {
      invalid_credentials: '账号或密码不对。',
      locked: (minutes: number) => `试错太多次，账号已锁定，${minutes} 分钟后再试。`,
      account_disabled: '这个账号已被停用。',
      already_bootstrapped: '已经初始化过了，直接登录即可。',
      invalid_input: (min: number) => `账号不能为空，密码至少 ${min} 位。`,
      missing_origin: '请求被同源校验拦下了。请从面板自身的地址访问。',
      cross_origin: '请求被同源校验拦下了。请从面板自身的地址访问。',
      unknown: (message: string) => `登录失败：${message}`,
    },
    lockoutNote: (max: number, minutes: number) => `连续 ${max} 次失败会锁定 ${minutes} 分钟。`,
  },

  /**
   * 带外恢复。密码丢了或账号锁死时用 settings 表里的一次性令牌重置。
   *
   * 服务端刻意把「没开窗口 / 令牌不对 / 已过期 / 账号名不对」压成同一个错误码，
   * 所以这里的失败文案必须把四种可能一起列出来 —— 替它猜是哪一种，就把它刻意
   * 隐藏的信息泄回去了。
   */
  recover: {
    toggle: '密码丢了？用恢复令牌重置',
    title: '用恢复令牌重置密码',
    lead: '需要能访问数据库的人先开一个一次性令牌窗口。令牌用过即失效。',
    subject: '要重置的账号',
    token: '恢复令牌',
    tokenHint: '至少 16 位',
    newPassword: '新密码',
    submit: '重置并登录',
    pending: '重置中…',
    ok: '密码已重置，正在登录…',
    howToTitle: '怎么开这个窗口',
    howToLead: '有账号权限的人执行下面任一种：',
    howToCi: 'CI：手动触发 admin-reset 工作流，按提示打字确认。',
    howToSql: '或者直接对 D1 写一行 settings（把占位换成真实值）：',
    sqlNote: '教学示意：把 <> 里的占位换成真实值再执行。',
    sqlTokenNote: (tokenLabel: string, tokenHint: string) =>
      `-- ${tokenLabel}（${tokenHint}；一次性，用过即失效）`,
    sqlExpiresAtNote: '过期时间，毫秒级时间戳；过期之后这个令牌不再可用',
    sqlPlaceholderToken: '你自己生成的令牌',
    sqlPlaceholderSubject: '账号名',
    errors: {
      recovery_unavailable:
        '没能重置。可能是：还没有人开恢复窗口、令牌写错了、令牌已过期，或者账号名和开窗口时指定的不一致。',
      invalid_input: (min: number) => `新密码至少 ${min} 位，令牌至少 16 位。`,
      unknown: (message: string) => `重置失败：${message}`,
    },
  },

  /** 草稿与生产的区别是这个面板的核心概念，措辞在各处必须一致。 */
  publishBar: {
    clean: '草稿与线上一致',
    cleanDetail: (revision: number) => `revision ${revision} 正在服务流量`,
    neverPublished: '还没有发布过',
    neverPublishedDetail: '线上暂无配置，反代不会代理任何流量',
    /**
     * 服务端只回答「草稿与线上是否一致」（指纹比对），拿不到改动条数 ——
     * 所以这里不编一个数字出来。说「有改动」是真的，说「3 项改动」是猜的。
     */
    dirty: '草稿有改动尚未发布',
    dirtyDetail: (routeCount: number) =>
      `发布后线上会变成这 ${routeCount} 条路由；在那之前流量仍走旧配置`,
    blocked: '配置有错，不能发布',
    blockedDetail: '修好下面列出的问题再发布',
    empty: '草稿是空的',
    emptyDetail: '至少要有一条启用的路由才能发布',
    publish: '发布到反代',
    publishing: '发布中…',
    review: '查看发布内容',
    seeIssues: '查看问题',
    liveRevision: (revision: number) => `线上 revision ${revision}`,
    discard: '舍弃草稿',
    discarding: '舍弃中…',
  },

  routes: {
    title: '路由表',
    countLabel: (count: number) => `${count} 条`,
    enabledCount: (enabled: number, total: number) => `${enabled} / ${total} 条启用`,
    orderNote: '顺序即优先级，第一个匹配到的路由胜出。',
    create: '新建路由',
    columns: {
      order: '#',
      id: 'ID',
      match: '匹配',
      upstream: '上游',
      status: '状态',
      updated: '最后修改',
      actions: '操作',
    },
    enabled: '启用',
    disabled: '停用',
    corrupt: '数据损坏',
    corruptHint: '这一行的 JSON 无法解析，需要重新编辑或删除。',
    anyHost: '任意 host',
    anyPath: '任意路径',
    moveUp: '上移一位',
    moveDown: '下移一位',
    edit: '编辑',
    duplicate: '复制一份',
    remove: '删除',
    rowMenu: (id: string) => `${id} 的操作`,
    updatedBy: (who: string, when: string) => `${when} · ${who}`,
    empty: {
      title: '还没有路由',
      description: '新建一条路由，把某个 host 或路径指向上游，然后发布给反代。',
      action: '新建第一条路由',
    },
    emptyViewer: {
      title: '还没有路由',
      description: '路由表是空的。需要管理员权限才能新建。',
    },
    deleteTitle: (id: string) => `删除路由 ${id}？`,
    deleteBody: '草稿里会立刻消失，但线上配置在下次发布之前不变。',
    deleteConfirm: '删除',
    deleted: (id: string) => `已从草稿删除 ${id}`,
    reordered: '顺序已更新',
    loadFailed: (message: string) => `加载路由失败：${message}`,
    actionFailed: (message: string) => `操作失败：${message}`,
  },

  defaults: {
    title: '全局默认值',
    description: '每条没有自己写这个字段的路由都会用这里的值。路由自己写了就以路由为准。',
    label: 'defaults（JSON 对象）',
    save: '保存默认值',
    saving: '保存中…',
    saved: '默认值已存入草稿',
    emptyPlaceholder: '{\n  "timeoutMs": 5000,\n  "retries": 2\n}',
    invalidJson: 'JSON 格式不对',
    tooBig: (kb: number) => `默认值太大，上限 ${kb} KB`,
  },

  editor: {
    createTitle: '新建路由',
    editTitle: (id: string) => `编辑路由 ${id}`,
    description: '保存只写进草稿，线上流量在发布之后才改变。',
    idLabel: '路由 ID',
    idHint: '字母或数字开头，可含 . _ -，最长 64 字符。保存后不能改。',
    idInvalid: 'ID 需要以字母或数字开头，可含 . _ -，最长 64 字符',
    idImmutable: 'ID 保存后不可更改',
    enabledLabel: '启用这条路由',
    enabledHint: '停用的路由留在草稿里，但不会进入发布的配置。',
    tabForm: '表单',
    tabJson: 'JSON',
    jsonLabel: '路由定义',
    jsonHint: '表单覆盖不到的字段可以直接在这里写。两个视图共享同一份数据。',
    jsonInvalid: 'JSON 格式不对，先修好才能切回表单',
    save: '保存到草稿',
    saving: '保存中…',
    cancel: '取消',
    saved: (id: string) => `${id} 已存入草稿`,
    saveFailed: (message: string) => `保存失败：${message}`,
    tooBig: (kb: number) => `定义太大，上限 ${kb} KB`,
    discardTitle: '放弃未保存的改动？',
    discardBody: '这个弹窗里的修改还没有存进草稿。',
    discardConfirm: '放弃改动',
    discardCancel: '继续编辑',
    /**
     * host 下拉候选来自 /api/domains（issue #19）。读不到的原因（未配凭据、
     * 接口失败、账号没绑定）由域名页负责解释，这里只留一行安静的小字：
     * 降级绝不锁输入。
     */
    hostFallbackNote: '读不到已绑定的域名，仍可直接输入。',
    hostEmpty: '没有匹配的域名，可直接输入',
  },

  /** 表单化编辑器的字段文案。help 直接对齐 README 的路由选项表。 */
  fields: {
    sections: {
      identity: '标识',
      identityHint: '这条路由的名字，以及它要不要进入发布的配置。',
      match: '匹配',
      matchHint: '决定哪些请求走这条路由。三个条件同时满足才算匹配。',
      upstream: '上游',
      upstreamHint: '请求转发到哪里。',
      timing: '超时与重试',
      timingHint: '每次尝试的时限，以及失败后要不要再试。',
      rewrite: '响应改写',
      rewriteHint: '让访客感觉自己没有离开代理。',
      guards: '访问控制',
      guardsHint: '在转发之前拦掉不该进来的请求：从哪来、来多快、你是谁。',
      headers: '注入请求头',
      headersHint: '发给上游时额外带上的头。',
    },
    matchHost: {
      label: 'host',
      placeholder: 'app.example.com',
      help: '要匹配的主机名。`*.example.com` 匹配子域，不匹配 example.com 本身。留空匹配任意 host。',
      dropdown: '从已绑定的域名里选一个',
    },
    matchPath: {
      label: 'path 前缀',
      placeholder: '/api',
      help: '路径前缀，按路径段边界匹配。想匹配一切就写 `/`；写 `/*` 会被当成字面前缀，匹配不到东西。',
    },
    matchMethods: {
      label: 'HTTP 方法',
      help: '不选表示所有方法都匹配。',
    },
    matchConditions: {
      label: '条件',
      help:
        '按请求头、查询参数或 cookie 再往细里分流量：所有条件都满足才算命中，想「或」就写两条路由，排在前面的先中。' +
        '值区分大小写——`X-Env: Prod` 和 `prod` 是两个值；请求头的名字不区分大小写，查询参数和 cookie 的名字区分。' +
        '这是路由不是验证：任何人都能自己发 `X-Internal: 1`，别拿它当访问控制。',
      add: '加条件',
      family: '条件类型',
      familyHeader: '请求头',
      familyQuery: '查询参数',
      familyCookie: 'cookie',
      name: '名称',
      nameHeader: '头名，如 X-Env',
      nameQuery: '参数名，如 debug',
      nameCookie: 'cookie 名，如 beta',
      op: '匹配方式',
      opEquals: '值等于',
      opPrefix: '值开头是',
      opPresent: '存在',
      opAbsent: '不存在',
      value: '值',
      valueHidden: '这条只看名字，不用填值',
      removeRow: '删除这条条件',
      conditionError: '有的条件还没写完：名称不能空，选「值开头是」时值也不能空。',
    },
    upstream: {
      label: 'upstream',
      placeholder: 'origin.example.com',
      help: '`host`、`host:port` 或 `host/base/path`。不要写协议。',
    },
    scheme: {
      label: 'scheme',
      help: '连上游用的协议。http 意味着边缘到上游这一段不加密。',
    },
    allowPrivateUpstream: {
      label: '允许私有网络上游',
      help: '放行 loopback、内网和云元数据地址。开了它，一个被改坏的上游值就能把代理变成内网探测器。',
    },
    stripPrefix: {
      label: '转发前去掉匹配的前缀',
      help: '上游在根路径提供服务时需要打开。',
    },
    timeoutMs: {
      label: '单次尝试等响应头',
      unit: '毫秒',
      help: '只管到上游发出响应头为止；正文有自己的两个时限。',
    },
    totalTimeoutMs: {
      label: '重试总时限',
      unit: '毫秒',
      help: '所有尝试加退避的总上限，同样只管到响应头。',
    },
    firstChunkTimeoutMs: {
      label: '等正文第一个字节',
      unit: '毫秒',
      help: '响应头之后等首字节；模型思考很久属于正常，这里要给够。',
    },
    streamIdleTimeoutMs: {
      label: '正文空闲时限',
      unit: '毫秒',
      help: '两个字节之间最长静默；只要还在滴数据就一直转发，没有总时长上限。',
    },
    retries: {
      label: '额外重试次数',
      help: '只有幂等方法会重试。',
    },
    retryBackoffMs: {
      label: '首次重试前等待',
      unit: '毫秒',
      help: '之后每次翻倍。',
    },
    rewriteHeaders: {
      label: '改写响应头',
      help: '把 Location、Refresh、Set-Cookie 指回代理自身的域名。',
    },
    manualRedirect: {
      label: '自己处理重定向',
      help: '拿到重定向响应而不是让上游跟完。',
    },
    websocket: {
      label: '转发 WebSocket 升级',
      help: '',
    },
    bodyRewrite: {
      label: '改写响应体',
      /**
       * 这里原来写着「开启后需要指定生效的 content-type」，是错的：`contentTypes`
       * 的 schema 默认值就是 `['text/html']`，开关一开就够用。那句话让人以为不填
       * 就不生效，于是要么不敢开，要么去手填一个更宽的列表。
       */
      help: '流式改写 HTML 里的链接，让站内导航留在代理上。默认只对 `text/html` 生效。',
      /** 打开之后立刻要看见的两件事：代价，和覆盖不到的地方。都是静默发生的。 */
      cost: '改写会剥掉上游的 `ETag`、`Last-Modified` 和 CSP —— 客户端缓存和上游的安全头都会跟着降级。',
      scope:
        '只覆盖上游 HTML 里的 URL 属性和 CSS 的 `url()`。JS 在运行时拼出来的地址、跨到另一个注册域的资源（比如 `githubassets.com`），都改不到。',
      rewriteLinks: '改写链接',
      rewriteLinksHelp:
        '把指向上游及其子域的绝对地址换成代理自己的域名。关掉之后这一段只做字面替换。',
      replace: '字面替换',
      replaceHelp: '对改写后的正文逐段做原文替换。查找为空的行不保存。',
      replaceFrom: '查找',
      replaceTo: '替换为',
      addRow: '加一行替换',
      removeRow: '删掉这一行替换',
      rewriteStyles: '改写样式里的地址',
      rewriteStylesHelp:
        '`<style>` 块、行内 `style`、以及 `<meta http-equiv="refresh">` 里的地址。关掉之后 CSS 里的背景图仍然从上游加载。',
      contentTypes: '生效的 content-type',
      contentTypesHelp: '留空按默认的 `text/html`。列表写宽了会把非文本响应改写成乱码。',
      fallbackCharset: '兜底字符集',
      fallbackCharsetHelp:
        '响应没声明字符集、或者声明了一个这个运行时解不了的，就按这个解码。猜错比不改写更糟。',
    },
    blockCountries: {
      label: '拒绝这些国家',
      help: 'ISO 3166-1 alpha-2 代码，逗号分隔。命中的请求返回 403。',
      placeholder: 'CU, IR',
    },
    allowCountries: {
      label: '只允许这些国家',
      help: '一旦填写，其余国家全部拒绝；来源国未知时按拒绝处理。',
      placeholder: 'CN, SG',
    },
    cors: {
      label: 'CORS',
      origins: '允许的 origin',
      originsHelp: '留空会反射任何调用方的 origin，等于让别的站点通过这个代理读取带凭据的响应。',
      originsPlaceholder: 'https://app.example.com',
      allowMethods: '允许的方法',
      allowMethodsHelp: '留空按反代自带的默认（GET、HEAD、PUT、POST、DELETE、PATCH、QUERY）。',
      allowHeaders: '允许的请求头',
      allowHeadersHelp: '浏览器预检时允许携带的自定义请求头，逗号分隔。',
      exposeHeaders: '暴露给浏览器的响应头',
      exposeHeadersHelp: '浏览器默认读不到多数自定义响应头，前端要读的头在这里列出来。',
      credentials: '允许携带凭据',
      credentialsHelp: '打开后浏览器才会把 cookie 带进跨域请求，也才读得到带凭据的响应。',
      maxAge: '预检结果缓存',
      maxAgeHelp: '秒。整数，留空不发送缓存指令。',
    },
    ip: {
      label: 'IP 规则',
      allow: 'allow（CIDR 或地址）',
      allowHelp: 'allow 列表写错一个字符，就会放进本想排除的地址。',
      deny: 'deny（CIDR 或地址）',
      denyHelp: 'deny 列表写错一个字符，就会挡掉正常的调用方。',
    },
    access: {
      label: '身份验证（你是谁）',
      hint: '回答「你是谁」：Cloudflare Access 的 JWT，或 API key 哈希。更优先的做法是整个域名挂 Cloudflare Access，验证发生在代码之前；这里是按路由的兜底。两种机制至少要配一种，全部拒绝时请求不会转发上游。',
      cfEnable: '校验 Cloudflare Access 的 JWT',
      team: 'team 名',
      teamHelp: '即 https://{team}.cloudflareaccess.com，只能是小写字母、数字和连字符。',
      audience: 'audience（AUD tag）',
      audienceHelp: 'JWT 的 aud 必须等于它，不等于按身份不符拒绝（403）。',
      emails: '邮箱白名单',
      emailsHelp: '逗号分隔。留空则认 audience；填了则 JWT 里的邮箱也必须在列。',
      emailsPlaceholder: 'alice@example.com',
      keys: 'API key 的 SHA-256 哈希',
      keysHelp:
        '存的是哈希，不是 key 本身。终端里生成一对：openssl rand -base64 32 | sha256sum，左边明文只显示这一次，右边 64 位 hex 粘到这里。',
      keysPlaceholder: '9f86d081884c7d659a2feaa0c55ad015…（64 位 hex）',
      header: 'key 所在的请求头',
      headerHelp: '默认 authorization（取 Bearer 后面的值）。自定义头填头名，值就是 key 本身。',
      keysDanger: 'access.keys',
    },
    forwardAuth: {
      label: '委托鉴权',
      url: '鉴权端点 URL',
      urlHelp:
        '完整 URL，比如 `https://sso.example.com/check`。每个请求都会先问它：2xx 放行，其他状态原样回传给调用方。',
      urlPlainHttp: '写 `http://` 意味着凭据以明文在边缘与鉴权端点之间传输。',
      copyRequestHeaders: '抄给鉴权端点的请求头',
      copyRequestHeadersHelp: '留空按默认的 `authorization, cookie`。鉴权端点靠它们认人。',
      copyResponseHeaders: '从鉴权响应抄进上游请求的头',
      copyResponseHeadersHelp: '比如 `x-user-id`——鉴权端点认完人之后，用这些头告诉上游「是谁」。',
      timeoutMs: '鉴权请求超时',
      timeoutMsHelp: '超过就按端点不可用处理。留空按默认的 2000 毫秒。',
      failOpen: '端点不可达时放行',
      failOpenHelp:
        '关闭时端点挂了返回 503；打开后端点挂了所有请求直接放行——只在「可用性高于准入」时才考虑。',
      failOpenDefault: '默认关闭（fail-closed）。',
      reserved: (names: string) =>
        `这些头由 jouska 从请求推导，或由运行时掌管传输，不能出现在这里：${names}`,
    },
    upstreamHeaders: {
      label: '注入的请求头',
      help: '这些头会原样发给上游。凭据类或身份伪装类的头写在这里等于交给第三方。',
      name: '头名',
      value: '值',
      // 只报实际写错的那几个名字。把整份保留清单打出来读者还得自己找是哪一个。
      reserved: (names: string) =>
        `这些头由 jouska 从请求推导，或由运行时掌管这一跳的传输与协商，写在这里会被拒：${names}`,
    },
    unknownFields: {
      label: '表单未覆盖的字段',
      help: '下面这些字段只能在 JSON 视图里编辑，保存时会原样保留。',
      /** 个别键需要一句「为什么表单没有它、它管什么」。 */
      keyHelp: {
        rateLimit:
          '需要在 wrangler 里绑定 native rate limiting binding，表单暂不覆盖，可在 JSON 视图配置。',
        upstreams: '按顺序排列的上游列表，配合 failover 做故障转移。可在 JSON 视图配置。',
        trafficSplit: '按权重分流的候选列表，每条是 `{ upstream, weight }`。可在 JSON 视图配置。',
        failover: '故障转移的触发条件与最大尝试次数，只在多上游路由上有意义。可在 JSON 视图配置。',
        stickyBy: '`"cookie"` 让同一次分流的后续请求黏在同一个上游。可在 JSON 视图配置。',
      } as Record<string, string>,
    },
  },

  /**
   * 域名发现。回答操作者写 match.host 时的两个问题：我哪个域名没人接，
   * 我哪条路由指着一个还没绑定的域名。
   */
  domains: {
    title: '绑定的域名',
    description: '从 Cloudflare 账号读出真正能打到反代的 hostname，并和路由表对一遍。',
    refresh: '重新读取',
    refreshing: '读取中…',
    scriptNote: (script: string) => `查询的是 Worker「${script}」的绑定。`,
    readOnlyNote: '只读查询，不写数据库也不进审计日志。',
    columns: {
      host: 'hostname',
      kind: '来源',
      zone: 'zone',
      routes: '接管它的路由',
    },
    kinds: {
      workers_dev: 'workers.dev',
      custom_domain: '自定义域',
      route: 'zone route',
    } as Record<string, string>,
    noRoute: '没有路由接管',
    noRouteHint: '这个域名能打到反代，但没有路由匹配它，请求会穿过去。',
    matchesAll: (count: number) => `${count} 条`,
    /** 路由写了 host 但账号里没有对应绑定。 */
    unmatchedTitle: '指向未绑定域名的路由',
    unmatchedHint: '这些路由的 host 在账号里找不到对应绑定：要么绑定还没做，要么是错字。',
    unmatchedLine: (routeId: string, host: string) => `${routeId} 指向 ${host}`,
    failuresTitle: '有来源读不到',
    failuresHint: '下面列出的来源查询失败了，所以这份清单可能不完整。',
    skippedZonesTitle: '跳过的 zone',
    skippedZonesHint: '令牌没有这些 zone 的读权限，它们的 route 绑定没被算进来。',
    unconfigured: {
      title: '还没配好凭据',
      description: '配上之后这一页会自动列出账号里所有能打到反代的域名。',
      missing_account_id: '缺 CF_ACCOUNT_ID。跑一次 npm run cf:setup 会把它写进本地的 .dev.vars。',
      missing_token: '缺 CF_API_TOKEN。用 wrangler secret put CF_API_TOKEN 设置。',
      missing_both: '缺 CF_ACCOUNT_ID 和 CF_API_TOKEN 两个值。',
      tokenScopeTitle: '令牌只需要读权限',
      tokenScopeHint:
        'Workers Scripts Read 覆盖 workers.dev 和自定义域；再加 Zone Read 和 Workers Routes Read 才能看到 zone route。给写权限会让面板一旦被攻破就等于整个账号被重配。',
      skipNote: '不配也没关系：其他每一页都照常工作。',
    },
    empty: {
      title: '账号里没有找到绑定',
      description: '这个 Worker 还没有 workers.dev 子域、自定义域或 zone route。',
    },
    loadFailed: (message: string) => `读取失败：${message}`,
  },

  preview: {
    title: '发布预览',
    description: '这里显示的是即将写入 KV 的内容。预览不写任何东西。',
    refresh: '重新检查',
    refreshing: '检查中…',
    routeCount: (count: number) => `${count} 条路由将上线`,
    // clean 态的同一行：内容已经上线，再说「将上线」就是在骗人发布。措辞对齐
    // publishBar.cleanDetail 的「正在服务流量」。
    routeCountLive: (count: number, revision: number) =>
      `这 ${count} 条路由正在服务流量（revision ${revision}）`,
    alreadyLive: '线上已是这版内容，不用再发布',
    ok: '草稿可以发布',
    documentTitle: '将写入 KV 的文档',
    documentHint: '反代在热路径上读的就是这份 JSON。',
    issuesTitle: '这些问题必须先修好',
    issuesHint: '校验用的是反代运行时的同一份 schema，所以这里报错等于线上会报错。',
    issueAt: (routeId: string, path: string) => `${routeId} · ${path}`,
    issueTable: '（整张表）',
    shadowTitle: '被遮蔽的路由',
    shadowHint: '顺序在前的路由已经把这些流量收走了，被遮蔽的那条永远不会执行。',
    shadowLine: (shadowed: string, by: string) => `${shadowed} 收不到流量，被 ${by} 抢先匹配`,
    shadowProbe: (probe: string) => `证据：${probe}`,
    shadowProbeHeaders: (headers: string) => `证据请求携带的头：${headers}`,
    mirrorTitle: '整站代理，但没开正文改写',
    mirrorHint:
      '转发没坏，是改写没开：上游 HTML 里的绝对链接会把访客直接带回上游。要留住站内导航，去那条路由的「响应改写」里打开「改写响应体」。',
    mirrorLine: (routeId: string, upstream: string) =>
      `${routeId} 把整站代理过来，页面里指向 ${upstream} 的绝对链接会把访客带走`,
    mirrorScope:
      '打开也不等于全都留得住：改写只覆盖服务端 HTML 里的 URL 与 CSS 的 url()，JS 运行时拼出来的地址、跨到另一个注册域的资源都不在范围内。',
    cacheVaryTitle: '缓存会按请求值分开存',
    cacheVaryHint: '这些路由开了缓存，条件又用到了请求头或 cookie，每种取值都会各存一条缓存。',
    cacheVaryLine: (routeId: string, names: string) =>
      `${routeId} 的缓存键会随 ${names} 的取值变化`,
    cacheVaryScope:
      '正确性不受影响——键里折进请求值，就是为了不让一个分支的缓存发给另一个分支；代价是命中率。查询参数不在此列，它本来就在 URL 里。',
    dangerTitle: '危险开关',
    dangerHint: '这些字段都有正当用途，但每次发布都需要你亲手确认一次。',
    dangerHigh: '高',
    dangerMedium: '中',
    empty: {
      title: '草稿里没有启用的路由',
      description: '先到「路由」页新建一条并启用，再回来发布。',
      action: '去新建路由',
    },
    loadFailed: (message: string) => `预览失败：${message}`,
  },

  publish: {
    noteLabel: '这次改了什么',
    notePlaceholder: '把 api 路由的超时从 5s 调到 8s',
    noteHint: (max: number) => `会写进审计日志和 KV 的 meta，最多 ${max} 字。`,
    confirmTitle: '确认发布',
    confirmBody: '发布会立刻改变线上流量的走向。',
    confirmDangerLead: '这份配置带着下面这些危险开关：',
    confirmSwitches: '我确认这些开关是有意打开的。',
    confirmAction: '确认发布',
    cancel: '取消',
    ok: (revision: number) => `已发布，revision ${revision}`,
    cancelled: '已取消，什么都没发布',
    failed: (message: string) => `发布失败：${message}`,
    forbidden: '只有管理员能发布。',
  },

  /**
   * 舍弃草稿 = 发布的草稿侧镜像：不写 KV、不产生 revision、不过发布闸。
   * 措辞必须与 publishBar / history 一起守住同一口径 —— 舍弃不是发布，线上
   * 那一版从头到尾没变过，变的只是草稿。
   */
  discard: {
    title: '舍弃未发布的草稿',
    body: (revision: number) =>
      `草稿将恢复为正在服务的 revision ${revision}，未发布的改动会被丢弃。线上流量的走向不受影响。`,
    parkNote: '快照里没有的路由不会被删除，只会停用并保留定义，随时可以重新启用。',
    cancel: '取消',
    confirmAction: '舍弃草稿',
    confirming: '舍弃中…',
    ok: (revision: number) => `草稿已恢复为 revision ${revision} 的内容。`,
    failed: (message: string) => `舍弃失败：${message}`,
    forbidden: '只有管理员能舍弃草稿。',
    errors: {
      nothing_published: '还没有发布过任何配置，没有「线上版本」可以恢复。',
      snapshot_unavailable:
        '线上那一版没有可用的快照（发布早于历史功能，或快照已损坏），恢复不了。',
      already_clean: '草稿已经和线上一致了，不需要舍弃。',
    } as Record<string, string>,
  },

  audit: {
    title: '审计日志',
    description: '每一次写操作都在这里，包括发布。',
    refresh: '刷新',
    columns: {
      at: '时间',
      actor: '操作者',
      action: '动作',
      target: '对象',
      detail: '详情',
    },
    actions: {
      'route.create': '新建路由',
      'route.update': '修改路由',
      'route.delete': '删除路由',
      'routes.reorder': '调整顺序',
      'defaults.update': '修改默认值',
      'config.publish': '发布配置',
      'config.rollback': '回滚配置',
      'config.discard': '舍弃草稿',
      'auth.password': '修改密码',
      'auth.recover': '恢复令牌重置',
      'user.create': '新建用户',
      'user.update': '修改用户',
      'user.delete': '删除用户',
      'mcp.token.create': '创建 MCP 令牌',
      'mcp.token.revoke': '撤销 MCP 令牌',
    } as Record<string, string>,
    viewDetail: '看详情',
    detailTitle: '审计详情',
    limitLabel: '显示条数',
    empty: {
      title: '审计日志是空的',
      description: '任何写操作都会在这里留下记录。',
    },
    loadFailed: (message: string) => `审计加载失败：${message}`,
  },

  /**
   * 发布历史与回滚。文案口径与发布弹窗保持同一套：回滚不是倒带计数，而是
   * 把旧版本重新发布成一个新 revision —— 措辞里始终说「成为新版本」。
   */
  history: {
    title: '发布历史',
    description: '每一次发布都是一个 revision。选两张卡对比改动，或把任意一版重新发布。',
    refresh: '刷新',
    liveBadge: '正在服务',
    rolledBackFrom: (revision: number) => `回滚自 #${revision}`,
    routes: (count: number) => `${count} 条路由`,
    routesUnknown: '路由数未知',
    snapshotNone: '无快照',
    snapshotNoneReason: '这次发布早于历史功能，只留下了审计记录 —— 能看，不能对比或回滚。',
    gap: (before: number, after: number) => `#${before} 与 #${after} 之间缺了一次记录`,
    gapReason: '那次发布改动已上线、但面板记录没写成（当时的写入失败），历史无法补记。',
    empty: {
      title: '还没有发布过',
      description: '第一次发布之后，这里会出现完整的时间轴。',
    },
    loadFailed: (message: string) => `历史加载失败：${message}`,

    diff: {
      select: '对比',
      selected: (revision: number) => `已选 #${revision}`,
      title: (a: number, b: number) => `对比 #${a} ↔ #${b}`,
      clear: '清除对比',
      loading: '正在对比…',
      empty: '两版内容完全一致。',
      failed: (message: string) => `对比失败：${message}`,
      groups: {
        added: '新增',
        removed: '删除',
        changed: '修改',
        moved: '移序',
      } as Record<string, string>,
      defaultsTitle: '表级默认值',
      routesTitle: '路由',
      fromLabel: '原值',
      toLabel: '新值',
      valueLabel: (value: string) => `改为 ${value}`,
      positionLabel: (from: number, to: number) =>
        `第 ${String(from + 1)} 位 → 第 ${String(to + 1)} 位`,
      truncated: '（过长已截断）',
      unavailable: '有一侧没有快照，对比不了。',
      corrupt: '有一侧快照损坏，对比不了。',
    },

    rollback: {
      action: '回滚',
      title: (revision: number) => `回滚到 revision ${revision}`,
      body: '回滚不是倒带：这一版会被重新发布成一个新 revision，历史照常向前走。',
      draftWarning:
        '草稿会同时被重置为这一版 —— 没发布的改动会丢弃；草稿里停用的路由不会被删，只是继续保持停用。',
      dangerLead: '这一版带着下面这些危险开关：',
      confirmSwitches: '我确认这些开关是有意打开的。',
      noteLabel: '备注（可选）',
      notePlaceholder: '为什么回滚，说一句就够了。',
      cancel: '取消',
      confirmAction: '确认回滚',
      ok: (source: number, revision: number) =>
        `已回滚到 #${source}，成为新 revision ${revision}。线上约 3 分钟内全面生效。`,
      failed: (message: string) => `回滚失败：${message}`,
      forbidden: '只有管理员能回滚。',
      errors: {
        snapshot_unavailable: '这一版没有快照，回不了。',
        snapshot_corrupt: '这一版的快照数据损坏，回不了。',
        revision_not_compatible: '这一版的配置在当前 schema 下不再合法，回不了。',
        already_live: '线上正在服务的就是这一版的内容，不用回。',
      } as Record<string, string>,
    },
  },

  mcp: {
    title: 'MCP 令牌',
    description: '给 Claude Code 等客户端连接 jouska。令牌只在创建成功时显示一次。',
    endpoint: 'MCP 地址',
    create: '创建令牌',
    refresh: '刷新',
    name: '名称',
    namePlaceholder: '例如：Claude Code',
    expires: '有效期',
    days: (days: number) => `${days} 天`,
    scopes: '权限',
    scopeLabels: {
      'config:read': '读取草稿与预览',
      'config:write': '修改草稿',
      'domains:read': '读取绑定域名',
      'audit:read': '读取审计日志',
    } as Record<string, string>,
    scopeHints: {
      'config:read': '可以查看路由、默认值和发布前检查结果。',
      'config:write': '可以创建、修改、删除和排序草稿；不会自动发布。',
      'domains:read': '可以查看反代 Worker 的可达域名。',
      'audit:read': '可以读取最近的审计记录。',
    } as Record<string, string>,
    createTitle: '创建 MCP 令牌',
    createBody: '令牌代表机器客户端，不继承你的全部管理员权限。',
    createAction: '生成令牌',
    creating: '生成中…',
    cancel: '取消',
    tokenTitle: '令牌只显示这一次',
    tokenBody: '现在复制并保存。关闭这个窗口后无法找回，只能重新创建。',
    copyToken: '复制令牌',
    copied: '已复制令牌',
    saved: '我已安全保存',
    columns: {
      name: '名称',
      prefix: '令牌',
      scopes: '权限',
      expires: '到期',
      lastUsed: '最近使用',
      status: '状态',
      actions: '操作',
    },
    active: '有效',
    revoked: '已撤销',
    expired: '已过期',
    neverUsed: '尚未使用',
    revoke: '撤销',
    revokeTitle: (name: string) => `撤销「${name}」？`,
    revokeBody: '撤销后，使用这个令牌的客户端会立即失去访问权限。',
    revokeAction: '确认撤销',
    empty: '还没有 MCP 令牌',
    emptyDescription: '创建一个令牌，让 AI 客户端读取或修改草稿配置。',
    loadFailed: (message: string) => `令牌加载失败：${message}`,
    createFailed: (message: string) => `令牌创建失败：${message}`,
    revokeFailed: (message: string) => `令牌撤销失败：${message}`,
    invalidName: '请输入令牌名称。',
    invalidScopes: '至少选择一项权限。',
    onlyOnce: '明文只显示一次',
  },

  /**
   * 已规划但还没有后端的功能。UI 只提供入口和一句实话，不做假界面 ——
   * 空壳按钮比没有按钮更让人以为坏了。用户管理与发布历史都已落地，
   * 从这张表里毕业了，剩下的是路由运行时数据。
   */
  planned: {
    badge: '待开发',
    observability: {
      title: '路由运行时数据',
      description:
        '每条路由的请求量、错误率、p95 延迟和上游健康。数据源还不存在，需要先接入 Analytics Engine。',
      items: ['按路由看请求量与错误率', '延迟分布', '上游可用性'],
      note: '',
    },
  },

  /**
   * 界面崩了时说什么。
   *
   * 第一句必须先回答人此刻最怕的那个问题：线上是不是也挂了。答案是没有 —— 反向
   * 代理是另一个 Worker，读的是 KV 里已发布的配置快照，面板前端崩掉不影响它转发
   * 任何一个字节。把这句放在道歉前面，才是有用的信息。
   */
  crash: {
    title: '这个界面崩了',
    lead: '线上的反向代理不受影响 —— 它是另一个 Worker，读已发布的配置快照，跟这块界面无关。坏的只是你眼前这个面板。',
    viewTitle: '这一页崩了',
    viewLead: '头部的导航和退出登录还能用，可以先换一页，或者重试这一页。',
    reload: '重新加载面板',
    retry: '重试这一页',
    details: '技术细节',
    detailsHint: '报 issue 时把下面这段一起贴上，比描述症状有用。',
  },

  common: {
    loading: '加载中…',
    retry: '重试',
    close: '关闭',
    cancel: '取消',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败，请手动选中',
    optional: '可选',
    defaultValue: (value: string) => `默认 ${value}`,
    unset: '未设置',
    // 行编辑器共用：请求头与字面替换。
    addRow: '加一行',
    removeRow: '删掉这一行',
    yes: '是',
    no: '否',
    networkError: '连不上服务器，检查一下网络或者面板是不是在部署中。',
    sessionExpired: '登录已过期，请重新登录。',
    forbidden: '这个操作需要管理员权限。',
    unknownError: '出了点问题',
  },
} as const;
