import { defineWebModule } from "@aihot/web/modules";
import { IconTable } from "../../apps/web/app/components/icons";

// 台账与 /regulations（动态资讯流）并列：一个回答「有哪些法规」，一个回答「最近发生了什么」。
export default defineWebModule({
  name: "source-table",
  sidebar: {
    section: "专栏",
    items: [{ to: "/sources", label: "法规信源", icon: IconTable }],
  },
});
