import { defineWebModule } from "@aihot/web/modules";
import { IconChart, IconDoc, IconGrid, IconUsers } from "../../apps/web/app/components/icons";

export default defineWebModule({
  name: "columns",
  sidebar: {
    section: "专栏",
    items: [
      { to: "/regulations", label: "法规追踪", icon: IconDoc },
      { to: "/standards", label: "标准解读", icon: IconGrid },
      { to: "/ncap", label: "NCAP 评测", icon: IconChart },
      { to: "/oem", label: "车企动态", icon: IconUsers },
    ],
  },
});
