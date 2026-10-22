import { defineWebModule } from "@aihot/web/modules";
import { IconMessage, IconRss } from "../../apps/web/app/components/icons";

export default defineWebModule({
  name: "subscriptions",
  sidebar: {
    section: "内容",
    items: [{ to: "/subscriptions", label: "订阅", icon: IconRss }],
  },
  tools: [{ to: "/subscriptions", label: "订阅与飞书推送", icon: <IconMessage size={20} /> }],
});
