"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Pagination } from "@/components/ui";

/**
 * 通用分页：页码 / 每页条数写入 URL，由服务端重新查询数据库。
 * basePath 默认为 /employees，各人员视图传入自己的路径即可复用。
 */
export default function ListPagination({
  page,
  totalPages,
  total,
  pageSize,
  basePath = "/employees",
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  basePath?: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  const goto = (patch: Record<string, string | number>) => {
    const params = new URLSearchParams(sp.toString());
    Object.entries(patch).forEach(([k, v]) => params.set(k, String(v)));
    router.push(`${basePath}?${params.toString()}`);
  };

  return (
    <Pagination
      page={page}
      totalPages={totalPages}
      total={total}
      pageSize={pageSize}
      onPageChange={(p) => goto({ page: p })}
      onPageSizeChange={(n) => goto({ pageSize: n, page: 1 })}
    />
  );
}
