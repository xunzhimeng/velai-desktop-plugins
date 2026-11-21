const MAX_RECORD_BYTES = 13 * 1024;
const DOC_FORMAT = 'velai.novel-studio';

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function countWords(text) {
  const m = (text || '').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\u3400-\u4dbf\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

const DEFAULT_BOOK = {
  schema_version: 1,
  title: '未命名长篇计划',
  genre: '科幻悬疑',
  logline: '点击右上角「加载演示项目《星渊回响》」可立即体验完整多卷小说、人物关系图谱、张力曲线与 AI 续写工作流。',
  target_words: 120000,
  chapters: [],
};

const DEFAULT_WORLD = { schema_version: 1, characters: [], relations: [], lore: [] };
const DEFAULT_PLOT = { schema_version: 1, threads: [] };

async function readKey(collection, key, fallback) {
  const r = await globalThis.nmas.data.read({ collection, key });
  return { revision: r.revision, value: r.value === null ? fallback : r.value };
}

async function writeKey(collection, key, expectedRevision, value) {
  if (jsonBytes(value) > MAX_RECORD_BYTES) {
    return { status: 'limit', revision: expectedRevision };
  }
  try {
    const r = await globalThis.nmas.data.write({
      collection,
      key,
      expected_revision: expectedRevision,
      value,
    });
    return { status: 'saved', revision: r.revision };
  } catch (e) {
    if (e?.code === 'conflict' && e.outcome_unknown === false) {
      return { status: 'conflict', revision: expectedRevision };
    }
    throw e;
  }
}

function computeTotalWords(chapters) {
  return chapters.reduce((acc, ch) => acc + (ch.word_count || 0), 0);
}

function demoPayload() {
  const chaptersMeta = [
    { id: 'ch-01', volume: '第一卷 · 沉没轨道', order: 1, title: '第1章 零号信标重启', status: 'done', tension: 6, pov: '林深', word_count: 342, summary: '深空打捞员林深在废弃轨道站发现早应销毁的零号信标正在向地球发送倒计时。' },
    { id: 'ch-02', volume: '第一卷 · 沉没轨道', order: 2, title: '第2章 静默档案室', status: 'done', tension: 5, pov: '沈清秋', word_count: 288, summary: '轨管局监察官沈清秋截获异常频段，发现信标签名竟属于十年前失踪的导师。' },
    { id: 'ch-03', volume: '第一卷 · 沉没轨道', order: 3, title: '第3章 失压舱门', status: 'revising', tension: 9, pov: '林深', word_count: 316, summary: '武装清道夫突袭打捞船，林深与沈清秋被迫在失压走廊联手逃生。' },
    { id: 'ch-04', volume: '第一卷 · 沉没轨道', order: 4, title: '第4章 灰烬议会', status: 'draft', tension: 7, pov: '陆沉舟', word_count: 195, summary: '议会副席陆沉舟下令封锁近地轨道，并启动尘封已久的“回声协议”。' },
    { id: 'ch-05', volume: '第二卷 · 逆向潮汐', order: 5, title: '第5章 记忆折射体', status: 'draft', tension: 8, pov: '林深', word_count: 170, summary: '解码信标内核后，众人震惊地发现它记录的不是过去，而是七十二小时后的未来画面。' },
  ];

  const bodies = {
    'ch-01': {
      beats: '1. 废弃轨道站外部作业压迫感\n2. 传感器捕捉 42Hz 异常脉冲\n3. 撬开铅封舱盖，零号信标亮起琥珀光\n4. 屏幕浮现林深本人的生物密钥与 72:00:00 倒计时',
      notes: '注意保持冷硬太空工业质感，不要过早揭示回声协议全貌。',
      body: '舱外探照灯切开近地轨道浓稠的黑，金属残骸在微重力下像一头搁浅的巨鲸缓缓翻身。林深把磁力靴扣死在主龙骨上，面罩里的呼气声被降噪算法压成一道枯燥的白噪音。\n\n“七号区辐射读数正常，但你在听什么？”耳机里传来副驾的杂音。\n\n“42 赫兹。”林深抬起手腕，示波器上正跳出一串极其规整的锯齿波，“十年前‘星渊号’解体后，这套加密频段就被轨管局永久吊销了。”\n\n他切开最后一道铅封锁扣。失重扬起的尘埃在光束里停顿了一瞬，舱壁深处那枚本该烧成焦炭的零号信标，正缓缓浮起一层温热的琥珀色微光。全息投影在他面罩前展开——没有求救信号，只有一行刺目的校验日志：「生物密钥匹配：林深。距离潮汐折叠还有 71:59:58。」',
    },
    'ch-02': {
      beats: '1. 轨管局地下监听塔的深夜值守\n2. 沈清秋拦截到被自动抹除的告警日志\n3. 对比十年前导师周明远留下的手写校验码\n4. 发现内部有人篡改了拦截白名单',
      notes: '突出沈清秋理智克制与内心执念的反差。',
      body: '凌晨三点十七分，近地轨管局地下四层的告警灯只闪了零点四秒就被系统自动静默。若不是沈清秋提前在底层总线上挂了物理镜像探针，这条来自废弃打捞区的异常脉冲就会像过去三年里的所有秘密一样人间蒸发。\n\n她放大频谱图，指尖停在末尾那组十六进制签名上。那是导师周明远独有的习惯——在每一个校验块的尾帧藏入一段巴赫赋格的频率比。\n\n“您果然没有死在星渊号上。”她低声自语，随即把镜像卡拔出藏进袖口。监控屏幕右上角，来自议会高层的强制覆写指令已经抵达，操作人署名为：陆沉舟。',
    },
    'ch-03': {
      beats: '1. 三艘无标识拦截艇封锁船坞\n2. 沈清秋亮明身份却反遭清道夫击杀令\n3. 走廊失压瞬间，林深切断气闸救下两人\n4. 信标在真空中发出第二段坐标',
      notes: '本卷第一个动作高潮，节奏要快，短句为主。',
      body: '警报撕裂舱内寂静的刹那，三道高能激光已经融穿了停泊舱的外装甲。林深一把将沈清秋拽进气闸盲区，滚烫的钛合金碎屑擦着护目镜呼啸而过。\n\n“你不是轨管局的监察官吗？他们为什么连你一起杀！”林深吼道。\n\n“因为下令封锁星渊档案的人，就在我们头顶！”沈清秋迅速将战术终端接入应急气阀，“左侧三十米是旧式逃生滑道，但主走廊已经失压！”\n\n没有犹豫的余地。林深反手拉下机械泄压杆，剧烈的气流瞬间卷走所有火焰，也把追兵逼退在厚重的防爆门后。他抓紧怀中滚烫的零号信标，在警报红光里纵身跃入失重通道。',
    },
    'ch-04': {
      beats: '1. 灰烬议会圆桌的冷酷博弈\n2. 陆沉舟展示十年前“星渊折叠”的机密影像\n3. 下令全面启动回声协议，宁可牺牲整条轨道环',
      notes: '让反派具备宏大而扭曲的“救世合理性”，而非脸谱化坏人。',
      body: '弧形落地窗外，蔚蓝的地球安静得像一枚易碎的玻璃珠。陆沉舟将茶杯轻轻搁在黑曜石长桌上，投影幕布随之切换成十年前那场从未公之于众的灾难——星渊号并非爆炸，而是被一道凭空出现的引力褶皱从时间轴上抹去了半截船体。\n\n“诸位，零号信标已经苏醒。”陆沉舟声音平稳得没有一丝波澜，“如果任由那名打捞员把里面的数据公之于众，七十二小时后崩溃的就不止一条轨道环。启动‘回声协议’吧。”',
    },
    'ch-05': {
      beats: '1. 逃亡至废弃中继塔解码信标\n2. 发现影像里的时间戳竟是三天后\n3. 影像中沈清秋在最后关头背叛了林深？留下悬念',
      notes: '第一卷与第二卷衔接钩子。',
      body: '中继塔的老旧算力阵列发出不堪重负的嗡鸣，进度条终于跳至 100%。全息画幅展开的一刻，舱内陷入死寂——画面里正在崩塌的近地穹顶上方，清晰地悬浮着三天后的太阳历日期。更让林深血液凝固的是，画面最后半秒，站在主控台前按下引爆键的人影，赫然转过沈清秋那张毫无表情的脸。',
    },
  };

  const world = {
    schema_version: 1,
    characters: [
      { id: 'c-linshen', name: '林深', role: 'protagonist', faction: '自由打捞公会', traits: '冷静、机械直觉极强、不信任体制', goal: '查清零号信标与自己生物密钥绑定的真相', secret: '十年前轨道事故唯一的记忆断层幸存者' },
      { id: 'c-shen', name: '沈清秋', role: 'supporting', faction: '近地轨管局', traits: '精密理性、外冷内热、原则极强', goal: '找到失踪导师周明远并揭露议会掩盖的事故', secret: '体内植入了导师留下的半枚回声密钥' },
      { id: 'c-lu', name: '陆沉舟', role: 'antagonist', faction: '灰烬议会', traits: '克制优雅、极端功利主义、掌控全局', goal: '在潮汐折叠前强行封锁轨道以保全地球本体', secret: '曾是周明远最亲密的联合研究员' },
      { id: 'c-zhou', name: '周明远', role: 'mentor', faction: '原星渊科研组', traits: '理想主义、密码学与引力场大师', goal: '将未来的警告提前送回七十二小时前', secret: '意识可能已被折叠进信标量子阵列' },
      { id: 'c-akira', name: '阿澈', role: 'supporting', faction: '自由打捞公会', traits: '话痨、顶尖黑客、重义气', goal: '帮林深保住打捞船并破解信标加密层', secret: '曾为灰烬议会外包写过追踪木马' },
    ],
    relations: [
      { id: 'r-1', from: 'c-linshen', to: 'c-shen', kind: 'ally', label: '被迫结盟 / 暗藏猜忌' },
      { id: 'r-2', from: 'c-shen', to: 'c-zhou', kind: 'mentor', label: '师徒羁绊' },
      { id: 'r-3', from: 'c-lu', to: 'c-zhou', kind: 'rival', label: '昔日挚友 / 理念决裂' },
      { id: 'r-4', from: 'c-lu', to: 'c-linshen', kind: 'rival', label: '猎杀与追逃' },
      { id: 'r-5', from: 'c-linshen', to: 'c-akira', kind: 'ally', label: '生死搭档' },
      { id: 'r-6', from: 'c-shen', to: 'c-lu', kind: 'secret', label: '上下级 / 暗中调查' },
    ],
    lore: [
      { id: 'l-1', category: 'artifact', title: '零号信标', detail: '星渊号唯一残留的量子黑匣子，以 42Hz 频段脉冲广播，能够逆向折射 72 小时内的未来观测画面。' },
      { id: 'l-2', category: 'faction', title: '灰烬议会', detail: '掌控近地轨道能源与防务的最高秘密委员会，奉行“宁可局部焚毁以保全文明存续”的冷酷铁律。' },
      { id: 'l-3', category: 'magic_tech', title: '潮汐折叠', detail: '人工引力引擎过载引发的局部时空褶皱现象，会让特定空间内的因果顺序出现短时倒置。' },
      { id: 'l-4', category: 'location', title: '沉没轨道带', detail: '距地表八百公里的退役空间站坟场，电磁干扰极强，是自由打捞船与地下黑市的天然掩护区。' },
    ],
  };

  const plot = {
    schema_version: 1,
    threads: [
      { id: 'th-1', title: '林深生物密钥为何提前写入零号信标', planted_ch: 1, payoff_ch: 12, status: 'planted', priority: 'critical', detail: '林深从未登过星渊号，但信标认他为最高权限持有人。' },
      { id: 'th-2', title: '巴赫赋格尾帧校验码', planted_ch: 2, payoff_ch: 6, status: 'hinted', priority: 'major', detail: '周明远留给沈清秋的暗语，指向中继塔隐藏坐标。' },
      { id: 'th-3', title: '未来影像中沈清秋按下引爆键的真相', planted_ch: 5, payoff_ch: 18, status: 'planted', priority: 'critical', detail: '究竟是背叛，还是为了阻止更大规模折叠的唯一解法？' },
      { id: 'th-4', title: '阿澈曾为议会编写的追踪后门', planted_ch: 3, payoff_ch: 8, status: 'hinted', priority: 'major', detail: '清道夫之所以精准锁定打捞船，是否与这段旧代码有关？' },
    ],
  };

  const book = {
    schema_version: 1,
    title: '星渊回响',
    genre: '硬科幻 / 太空悬疑',
    logline: '一枚提前七十二小时传回未来灾难影像的量子信标，让深空打捞员与轨道监察官卷入跨越十年的因果迷局。',
    target_words: 150000,
    chapters: chaptersMeta,
  };

  return { book, bodies, world, plot };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'novel.bootstrap') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      const worldRes = await readKey('world', 'bible', DEFAULT_WORLD);
      const plotRes = await readKey('plot', 'board', DEFAULT_PLOT);
      const book = metaRes.value;
      const world = worldRes.value;
      const plot = plotRes.value;
      return {
        revision: metaRes.revision,
        book: {
          title: book.title,
          genre: book.genre,
          logline: book.logline,
          target_words: book.target_words,
          total_words: computeTotalWords(book.chapters || []),
          chapters: book.chapters || [],
        },
        characters: world.characters || [],
        relations: world.relations || [],
        lore: world.lore || [],
        threads: plot.threads || [],
      };
    }

    if (contribution === 'novel.book.save') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (metaRes.revision !== input.expected_revision) return { status: 'conflict', revision: metaRes.revision };
      const title = input.title.trim();
      if (!title) return { status: 'invalid_input', revision: metaRes.revision };
      const next = {
        ...metaRes.value,
        schema_version: 1,
        title,
        genre: input.genre.trim(),
        logline: input.logline.trim(),
        target_words: input.target_words,
      };
      return writeKey('meta', 'book', input.expected_revision, next);
    }

    if (contribution === 'novel.chapter.get') {
      const r = await readKey('chapters', `ch:${input.id}`, null);
      if (!r.value) return { found: false, revision: r.revision };
      return {
        found: true,
        revision: r.revision,
        body: r.value.body || '',
        beats: r.value.beats || '',
        notes: r.value.notes || '',
      };
    }

    if (contribution === 'novel.chapter.save') {
      const { expected_revision, id, volume, title, status, tension, pov, summary, beats, notes, body } = input;
      if (!title.trim() || !/^[a-zA-Z0-9._-]+$/.test(id)) return { status: 'invalid_input', revision: expected_revision };
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (metaRes.revision !== expected_revision) return { status: 'conflict', revision: metaRes.revision };

      const chDoc = { schema_version: 1, body, beats, notes };
      const savedBody = await writeKey('chapters', `ch:${id}`, expected_revision, chDoc);
      if (savedBody.status !== 'saved') return savedBody;

      const word_count = countWords(body);
      const list = metaRes.value.chapters || [];
      const existing = list.find(c => c.id === id);
      const entry = {
        id,
        volume: volume.trim() || '第一卷',
        order: existing ? existing.order : list.length + 1,
        title: title.trim(),
        status,
        tension,
        pov: pov.trim(),
        word_count,
        summary: summary.trim(),
      };
      const nextChapters = existing ? list.map(c => (c.id === id ? entry : c)) : [...list, entry];
      const savedMeta = await writeKey('meta', 'book', savedBody.revision, { ...metaRes.value, schema_version: 1, chapters: nextChapters });
      return savedMeta.status === 'saved' ? { status: 'saved', revision: savedMeta.revision, word_count } : savedMeta;
    }

    if (contribution === 'novel.chapter.delete') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (metaRes.revision !== input.expected_revision) return { status: 'conflict', revision: metaRes.revision };
      const list = metaRes.value.chapters || [];
      if (!list.some(c => c.id === input.id)) return { status: 'not_found', revision: metaRes.revision };
      const nextChapters = list.filter(c => c.id !== input.id).map((c, idx) => ({ ...c, order: idx + 1 }));
      const saved = await writeKey('meta', 'book', input.expected_revision, { ...metaRes.value, chapters: nextChapters });
      return saved.status === 'saved' ? { status: 'deleted', revision: saved.revision } : { status: 'conflict', revision: saved.revision };
    }

    if (contribution === 'novel.world.save') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (metaRes.revision !== input.expected_revision) return { status: 'conflict', revision: metaRes.revision };
      return writeKey('world', 'bible', input.expected_revision, {
        schema_version: 1,
        characters: input.characters,
        relations: input.relations,
        lore: input.lore,
      });
    }

    if (contribution === 'novel.plot.save') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (metaRes.revision !== input.expected_revision) return { status: 'conflict', revision: metaRes.revision };
      return writeKey('plot', 'board', input.expected_revision, {
        schema_version: 1,
        threads: input.threads,
      });
    }

    if (contribution === 'novel.seed_demo') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (metaRes.revision !== input.expected_revision) return { status: 'conflict', revision: metaRes.revision };
      const demo = demoPayload();
      let rev = input.expected_revision;
      for (const [chId, doc] of Object.entries(demo.bodies)) {
        const w = await writeKey('chapters', `ch:${chId}`, rev, { schema_version: 1, ...doc });
        if (w.status !== 'saved') return { status: 'conflict', revision: w.revision };
        rev = w.revision;
      }
      const wWorld = await writeKey('world', 'bible', rev, demo.world);
      if (wWorld.status !== 'saved') return { status: 'conflict', revision: wWorld.revision };
      rev = wWorld.revision;
      const wPlot = await writeKey('plot', 'board', rev, demo.plot);
      if (wPlot.status !== 'saved') return { status: 'conflict', revision: wPlot.revision };
      rev = wPlot.revision;
      const wBook = await writeKey('meta', 'book', rev, demo.book);
      if (wBook.status !== 'saved') return { status: 'conflict', revision: wBook.revision };
      return { status: 'seeded', revision: wBook.revision };
    }

    if (contribution === 'document.list') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      const items = [{ id: 'bible', label: `全书大纲与设定集 (${metaRes.value.title})` }];
      for (const ch of metaRes.value.chapters || []) {
        items.push({ id: ch.id, label: `章节：${ch.title} (${ch.word_count} 字)` });
      }
      return { items };
    }

    if (contribution === 'document.export') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      if (input.id === 'bible') {
        const w = await readKey('world', 'bible', DEFAULT_WORLD);
        const p = await readKey('plot', 'board', DEFAULT_PLOT);
        const text = JSON.stringify({ format: DOC_FORMAT, version: 1, kind: 'bible', book: metaRes.value, world: w.value, plot: p.value }, null, 2);
        return { filename: 'novel-bible.json', text };
      }
      const meta = (metaRes.value.chapters || []).find(c => c.id === input.id);
      if (!meta) return { error: 'not_found' };
      const ch = await readKey('chapters', `ch:${input.id}`, { body: '', beats: '', notes: '' });
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, kind: 'chapter', meta, content: ch.value }, null, 2);
      return { filename: `novel-${input.id}.json`, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1) return { imported: false, reason: 'invalid_document' };
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      let rev = metaRes.revision;
      if (parsed.kind === 'chapter' && parsed.meta?.title) {
        const newId = `ch-${Date.now().toString(36)}`;
        const body = String(parsed.content?.body || '').slice(0, 10000);
        const w1 = await writeKey('chapters', `ch:${newId}`, rev, {
          schema_version: 1,
          body,
          beats: String(parsed.content?.beats || '').slice(0, 1000),
          notes: String(parsed.content?.notes || '').slice(0, 1000),
        });
        if (w1.status !== 'saved') return { imported: false, reason: w1.status };
        const list = metaRes.value.chapters || [];
        const nextEntry = {
          id: newId,
          volume: String(parsed.meta.volume || '导入卷').slice(0, 60),
          order: list.length + 1,
          title: String(parsed.meta.title).slice(0, 100),
          status: ['draft', 'revising', 'done'].includes(parsed.meta.status) ? parsed.meta.status : 'draft',
          tension: Math.min(10, Math.max(1, Number(parsed.meta.tension) || 5)),
          pov: String(parsed.meta.pov || '').slice(0, 40),
          word_count: countWords(body),
          summary: String(parsed.meta.summary || '').slice(0, 240),
        };
        const w2 = await writeKey('meta', 'book', w1.revision, { ...metaRes.value, chapters: [...list, nextEntry] });
        return w2.status === 'saved' ? { imported: true } : { imported: false, reason: w2.status };
      }
      return { imported: false, reason: 'unsupported_kind' };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'novel.outline') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      const plotRes = await readKey('plot', 'board', DEFAULT_PLOT);
      const chapters = (metaRes.value.chapters || []).map(({ id, order, title, tension, pov, summary }) => ({ id, order, title, tension, pov, summary }));
      if (!chapters.length) return { success: true, status: 'empty', title: metaRes.value.title, total_words: 0, chapters: [], open_threads: [] };
      const open_threads = (plotRes.value.threads || [])
        .filter(t => t.status === 'planted' || t.status === 'hinted')
        .map(({ title, planted_ch, priority }) => ({ title, planted_ch, priority }));
      return {
        success: true,
        status: 'ready',
        title: metaRes.value.title,
        total_words: computeTotalWords(metaRes.value.chapters || []),
        chapters,
        open_threads,
      };
    }

    if (contribution === 'novel.chapter.read') {
      const metaRes = await readKey('meta', 'book', DEFAULT_BOOK);
      const ch = (metaRes.value.chapters || []).find(c => c.id === input.id);
      if (!ch) return { success: false, status: 'not_found' };
      const content = await readKey('chapters', `ch:${input.id}`, { body: '', beats: '' });
      return {
        success: true,
        status: 'ready',
        title: ch.title,
        pov: ch.pov,
        beats: content.value.beats || '',
        body: content.value.body || '',
      };
    }

    if (contribution === 'novel.bible.upsert') {
      if (input.kind === 'thread') {
        const plotRes = await readKey('plot', 'board', DEFAULT_PLOT);
        const id = `th-${Date.now().toString(36)}`;
        const next = [
          ...(plotRes.value.threads || []),
          { id, title: input.title.trim(), planted_ch: input.planted_ch || 1, payoff_ch: 0, status: 'planted', priority: 'major', detail: input.detail.trim().slice(0, 240) },
        ];
        const saved = await writeKey('plot', 'board', plotRes.revision, { schema_version: 1, threads: next });
        return { success: saved.status === 'saved', status: saved.status, id };
      }
      const worldRes = await readKey('world', 'bible', DEFAULT_WORLD);
      const id = `l-${Date.now().toString(36)}`;
      const nextLore = [
        ...(worldRes.value.lore || []),
        { id, category: input.kind, title: input.title.trim(), detail: input.detail.trim() },
      ];
      const saved = await writeKey('world', 'bible', worldRes.revision, { ...worldRes.value, schema_version: 1, lore: nextLore });
      return { success: saved.status === 'saved', status: saved.status, id };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
