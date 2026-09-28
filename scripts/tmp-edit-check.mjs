import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const HOST = "http://127.0.0.1:3000";

const u = process.env.PROBE_USER;
const p = process.env.PROBE_PASS;
let sid = "";
const login = await fetch(`${HOST}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: u, password: p }),
});
sid = /hr_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
console.log("login", login.status, "sid?", !!sid);

const emp = await prisma.employee.findFirst({
  where: { deletedAt: null, status: "ACTIVE" },
  select: { id: true, name: true },
});
console.log("探查员工", emp.id, emp.name);

const res = await fetch(`${HOST}/employees/${emp.id}/edit`, { headers: { cookie: `hr_session=${sid}` } });
const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, "");
console.log("编辑页 HTTP", res.status, "长度", html.length);

const probe = (name, re) => {
  const m = html.match(re);
  console.log(`  ${name}: ${m ? "有" : "无"} ${m ? "(" + m.slice(0, 90).replace(/\s+/g, " ") + ")" : ""}`);
};

probe("面试地点 label", /面试地点/);
probe("面试地点 门店搜索框", /输入门店名/);
probe("面试地点 <input> 数", null);
probe("面试结果 label", /面试结果/);
probe("通过/不通过 按钮", /(通过|不通过)/);
probe("简历表 label", /简历表/);
probe("面试评估表 label", /面试评估表/);
probe("入职表 label", /入职表/);
probe("√ 字符", /√/);
probe("留空提示", /留空/);

// 关键：这些字段是否还同时出现在折叠分组里（出现两次=没改好）
const countLabel = (t) => (html.match(new RegExp(t, "g")) || []).length;
console.log("\n各 label 出现次数（>1 说明重复渲染）:");
for (const t of ["面试地点", "面试结果", "简历表", "面试评估表", "入职表"]) {
  console.log(`  ${t}: ${countLabel(t)}`);
}

// 折叠分组里是否还有它们（TEXT_GROUPS 展开时）
console.log("\n折叠分组标题命中:");
for (const t of ["招聘 / 面试", "合同与入职资料"]) {
  console.log(`  ${t}: ${countLabel(t)}`);
}

await prisma.$disconnect();
