-- 模型调用的每分钟预算按上游网关的限额来定：网关限 40 RPM，且与站外的对话代理共用配额，
-- 所以站内取 36，留出余量。预算是真正的内存与账单保护（DES §9.4），熔断只会让内容变慢，
-- 不会让 worker 打爆连接。逐服务名设置，抓取用的按次计费服务（jina/socialdata/dajiala）不动。
-- 后台「设置」里仍可继续调整，这里只是把新部署的初值定在安全的一侧。
UPDATE budgets SET per_minute = 36, per_hour = 900, per_day = 8000,
       note = '模型调用熔断（网关 40 RPM，留余量给站外代理）'
 WHERE service IN ('llm', 'zhipu', 'deepseek', 'dashscope', 'mimo');
