import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "subscriptions",
  pages: [{ path: "subscriptions", file: "web/subscriptions.tsx", id: "subscriptions" }],
});
