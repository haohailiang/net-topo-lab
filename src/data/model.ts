/**
 * 领域模型：一个"拓扑"就是一张独立的图，层与层之间用「下钻路径」串起来。
 *
 * 与真实业务的对应（数据全部由程序合成，不含任何真实网络信息）：
 *
 *   第1层  主干层：只显示最顶层的主干链路，下面的子网和中间设备都被抽象掉了。
 *          形态是一条主干链，相邻两个主干网元之间是一条抽象链路。
 *
 *   第2~3层 展开层：点一条主干链路（或一个域），展开它内部 —— 左右两个端点
 *          网元 + 中间 2~3 条并行路径，每条路径由若干中继设备串联。
 *          这是「条状」结构，不是网状：聚焦两点之间有哪几条路可以通。
 *
 *   第4层  单板层：第3层整张拓扑上的一个全局「详情」按钮进入，
 *          展开的是第3层全部网元 + 全部端口的单板（≤1000 块），
 *          既含单板也含单板之间的 CTP 连接。这一层不再下钻。
 *
 * 每层都是一张可独立缩放、独立刷新的图。切换分支时同层被顶替，
 * 它下面所有层整棵销毁。
 */

export type LayerIndex = 1 | 2 | 3 | 4;

/** 一段下钻路径：走的是链路、域，还是整层的详情。label 供面包屑显示 */
export type PathSeg = {
  kind: 'link' | 'domain' | 'detail';
  id: string;
  label: string;
};

export type NodeKind = 'ne' | 'board';

export interface TopoNode {
  id: string;
  name: string;
  layer: LayerIndex;
  kind: NodeKind;
  size: number;
  /** 该节点可直接下钻的链路 id —— 点这些链路会展开下一层 */
  drillLinks: string[];
  /** 该节点所属的域（域的下钻入口画在域框上，不画在节点上） */
  domainId?: string;
  /** 是否由上一层下钻而来、作为这条路径的入口端点 */
  entry: boolean;
  /** 属于第几条并行路径（0 起），条状布局靠它分带 */
  pathIndex?: number;
  /** 仅单板层有：这块单板属于哪个网元，供分组布局与 LOD 使用 */
  ownerName?: string;
  /** 仅单板层有：所属网元的 id，供告警向上汇聚时过滤 */
  ownerId?: string;
}

export interface TopoLink {
  id: string;
  label: string;
  source: string;
  target: string;
  /** 能不能继续下钻。不可下钻的链路在图上点不动 */
  drillable: boolean;
  /** 属于第几条并行路径（0 起），用于条状布局把节点分带 */
  pathIndex?: number;
  /** 仅单板层有：这条连接是网元内部的背板连接，还是跨网元的 CTP 连接 */
  ctpScope?: 'inner' | 'cross';
}

export interface DomainBox {
  id: string;
  name: string;
  /** 固定两个成员网元 —— 对应"后端已经分好组的一个域" */
  members: string[];
  drillable: boolean;
}

export interface LayerTopo {
  /** 从根到这一层的路径；根层为空数组 */
  path: PathSeg[];
  layer: LayerIndex;
  title: string;
  subtitle: string;
  nodes: TopoNode[];
  links: TopoLink[];
  domains: DomainBox[];
  /** 第3层为 true：整层有一个「详情」按钮，可进入单板层 */
  canEnterBoard: boolean;
}

/* ---------------------------------------------------------------- 告警 */

/** 一级最高、二级次之、三级最低；节点颜色取现存告警里的最高级别 */
export type AlarmLevel = 1 | 2 | 3;

/**
 * 四类告警，四个作用对象：
 *   ne    网元告警     -> 只落在网元节点上
 *   port  端口告警     -> 同时落在网元节点和那条链路上
 *   board 单板告警     -> 只出现在第4层，向上只汇聚到所属网元，不再上溯
 *   ctp   交叉连接告警 -> 第4层的"端口级"告警，向上汇聚到网元 + 端口两处
 */
export type AlarmKind = 'ne' | 'port' | 'board' | 'ctp';

export interface Alarm {
  id: string;
  kind: AlarmKind;
  level: AlarmLevel;
  /** 告警挂载的图元 id：网元节点 / 链路 / 单板节点 */
  objectId: string;
  /** 端口类与 ctp 类告警同时命中的对端 id（网元或链路的另一端） */
  peerId?: string;
  /** 单板层告警的归属网元 id —— 向上汇聚到网元时靠它过滤 */
  ownerId?: string;
}

/** 一个图元上汇总出来的告警摘要 */
export interface Digest {
  /** 0 表示干净无告警 */
  topLevel: 0 | 1 | 2 | 3;
  /** 去重后的告警对象总数（角标数字） */
  count: number;
  byKind: Record<AlarmKind, number>;
}

export const EMPTY_DIGEST: Digest = {
  topLevel: 0,
  count: 0,
  byKind: { ne: 0, port: 0, board: 0, ctp: 0 },
};

export const ALARM_COLORS: Record<1 | 2 | 3, string> = {
  1: '#e5484d',
  2: '#f28b30',
  3: '#e3b505',
};

export type ScaleKey = 'S' | 'M' | 'L';
