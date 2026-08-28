(() => {
  const STORAGE_KEY = "beize-org-chart:demo:v1";
  const VERSION_KEY = "beize-org-chart:beize-seed-version";
  const VERSION = "5";

  if (localStorage.getItem(VERSION_KEY) === VERSION) return;

  const now = new Date().toISOString();
  const node = (id, parent_id, type, name, title = "", notes = "", sort_order = 0) => ({
    id,
    organization_id: null,
    parent_id,
    type,
    name,
    title,
    notes,
    sort_order,
    version: 1,
    updated_at: now,
    updated_by: null,
    deleted_at: null,
    deleted_batch_id: null,
  });

  const seed = [
    node("beize-company", null, "company", "北泽五金", "", "东莞市北泽五金制品有限公司", 0),

    node("dept-gm", "beize-company", "department", "总经办", "", "", 10),
    node("gm-hlq", "dept-gm", "person", "洪礼群", "总经理", "公司经营管理", 10),
    node("gm-hxh", "dept-gm", "person", "洪晓辉", "总经理", "公司经营管理", 20),

    node("dept-sales", "beize-company", "department", "销售部", "", "", 20),
    node("dept-tech", "beize-company", "department", "技术部", "", "", 30),
    node("dept-production", "beize-company", "department", "生产部", "", "", 40),
    node("dept-warehouse", "beize-company", "department", "仓储部", "", "", 50),
    node("dept-purchase", "beize-company", "department", "采购部", "", "", 60),
    node("dept-finance", "beize-company", "department", "财务部", "", "", 70),

    node("dept-quality", "beize-company", "department", "品质部", "", "", 80),
    node("quality-qe", "dept-quality", "person", "程兴宇", "QE / 品质负责人", "品质体系、客诉、供应商质量、异常改善", 10),
    node("quality-qa", "dept-quality", "person", "蔡晓霞", "QA（规划）", "后续岗位规划", 20),
    node("quality-data", "dept-quality", "person", "吴宝玉", "品质数据员", "品质数据、资料与异常履历", 30),
    node("quality-iqc1", "dept-quality", "person", "王珍", "IQC", "来料检验", 40),
    node("quality-iqc2", "dept-quality", "person", "何陈妹", "IQC", "来料检验", 50),
    node("quality-oqc1", "dept-quality", "person", "杨巧", "OQC", "出货检验", 60),
    node("quality-oqc2", "dept-quality", "person", "贺家佳", "OQC", "出货检验", 70),
    node("quality-ipqc", "dept-quality", "person", "待招聘", "IPQC", "制程巡检岗位规划", 80),
    node("quality-lab", "dept-quality", "person", "待招聘", "实验室测试员", "实验室岗位规划", 90),
  ];

  localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
  localStorage.setItem(VERSION_KEY, VERSION);
})();
