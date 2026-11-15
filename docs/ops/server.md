# 服务器端要做的事

插件跑在 DSH 这一侧，真正干活的是远端那台运行 `agy acp` 的机器。那台机器的资源问题会以
"插件坏了" 的样子出现，所以装完插件之后，建议在那台机器上再跑一次
[`scripts/server-guard.sh`](../../scripts/server-guard.sh)。

这份脚本的目标是**不需要人守着**：它每分钟自己看一遍，该收的收、该救的救、救不回来才重启机器。

## 为什么需要

一次真实事故，同一台机器上同时出现三件事：

- 上一个 DSH 进程留下的转发还占着远端端口，新的转发绑不上，日志里刷了 1336 次
  `cannot listen to port`。
- 那台机器只有 1.6G 内存，**没有 swap**。
- 从出现内存压力到彻底不再写日志，中间只有六分钟；之后它还能接受 TCP 连接，但不再回 SSH
  banner，`agy` 的工具通道和额度桥一起失联，只能靠人重启。

插件这一侧已经改了：远端端口被占时会换端口、所有端口都失败时会说清是主机的问题、隧道尝试
有总量预算（默认每 10 分钟 20 次），正常退出也会先把会话关掉再拆链路。但**机器本身会不会
把自己拖死**，插件管不了——那是这份脚本的事。

## 脚本装了什么

幂等安装，重复运行只补齐缺失项，不会重建已有的 swap。

1. **swap 和低 swappiness**：默认 2G，写进 `/etc/fstab`；`vm.swappiness=10`。没有 swap 的
   1.6G 机器，一次突发就是整机卡死；有 swap 最差是变慢。
2. **日志上限**：journald 限制 200M，并给看护日志配轮转。
3. **每分钟一次的看护**（`antigravity-guard.timer`），每次都做这几件事：

| 情况 | 自动动作 |
|---|---|
| `agy acp` 的父进程已经不在 | 结束它。`sshd` 正常会在会话结束时收掉，父进程变成 1 说明没收掉，这类 worker 会一直占内存到下次重启 |
| 可用内存 < 150M | 按 RSS 从大到小结束 worker，直到回到 150M 以上（最多 3 个）。被结束的那条 ACP 会话会在插件下一轮重建 |
| 磁盘占用 ≥ 85% | 收缩 journald 到 100M、删掉 3 天前的 `.gz` 日志、清空轮转中的看护日志 |
| 端口 22 连续两次拿不到 SSH banner | 重启 `sshd`，并验证它恢复应答。30 分钟内最多 3 次，防止重启循环 |
| 可用内存 < 80M **且** sshd 已经不应答 | 重启机器。这是最后手段，只在"已经冻住"这个特征同时成立时触发，且每次开机最多一次 |

4. **内核看门狗（softdog）**：上面那些都跑在用户态，如果用户态整个停住（内存冻死就是这种），
   就没有任何计划任务能执行。softdog 是内核里的计时器，systemd 每 60 秒喂一次；喂不上，
   机器 120 秒后自己重启。这正是这次事故里缺的那一层——冻住两小时没有人管。

## 怎么装

把仓库里的脚本传到那台机器上执行，两台（或多台）各跑一次：

```sh
scp scripts/server-guard.sh user@host:/tmp/
ssh user@host 'sudo bash /tmp/server-guard.sh'
```

不想落盘也可以直接管道：

```sh
ssh user@host 'sudo -n bash -s' < scripts/server-guard.sh
```

非 root 机器用 `sudo` 执行，脚本自己会检查权限。装完会打印内存、swap、sshd banner 探测结果、
定时器状态和第一行看护记录。

## 怎么读

```sh
tail -5 /var/log/antigravity-guard.log
```

```
17:04:37 status=ok  load=0.00 mem_avail=1155M swap=0/2047M iowait=0% disk=16% agy=1 orphan=0 reaped=0 actions=0
17:05:08 status=ok  load=0.00 mem_avail=1166M swap=0/2047M iowait=0% disk=16% agy=2 orphan=1 reaped=1 actions=1
17:05:08 action=reaped-orphan pid=3441
```

- `actions` 是这一轮动手的次数，`action=` 开头的行是具体做了什么的记录。
- `status=warn` 会带上原因：`mem<200M`、`disk>=85%`、`swap>=80%`、`sshd-no-banner`。
- `orphan` / `reaped` 持续增长，说明有客户端在反复断开又没干净收尾。

## 阈值

用环境变量覆盖，不用改代码：

| 变量 | 默认 | 含义 |
|---|---|---|
| `SWAP_SIZE` | `2G` | 新建 swap 的大小 |
| `MEM_WARN_MB` | `200` | 可用内存低于它记 warn |
| `MEM_FREE_MB` | `150` | 低于它开始结束 worker |
| `MEM_REBOOT_MB` | `80` | 低于它且 sshd 无应答时重启机器 |
| `DISK_WARN_PCT` | `85` | 磁盘占用超过它记 warn 并清日志 |
| `SSHD_PROBE_TIMEOUT` | `4` | banner 探测的超时秒数 |
| `WATCHDOG_SEC` | `120s` | 用户态停住多久后由内核看门狗重启机器 |

重跑脚本会按新阈值重写看护脚本；swap 不会被重建。

不需要自动重启机器的话，把 `MEM_REBOOT_MB` 设成 `0` 就能关掉这一条（其余自动化照旧）。

## 和云监控的关系

自动化全在这台机器上，不需要人值守，也不需要报警规则：

- 主机监控需要装 `argusagent` 才能看到内存/swap，装它只是为了事后回看曲线，不是为了报警。
- 内存、磁盘、孤儿 worker、sshd 卡死、机器冻死，都已经有自动动作。
- 唯一没有自动答案的情况是**整台实例彻底失联**（宿主机故障、网络中断）。那种情况机器自身
  无法上报，任何告警都只是通知人——如果要求完全不需要人，就别配告警，接受这一种情况由
  云厂商兜底。

## 卸载

```sh
sudo systemctl disable --now antigravity-guard.timer
sudo rm -f /etc/systemd/system/antigravity-guard.{service,timer} \
           /usr/local/sbin/antigravity-guard \
           /etc/logrotate.d/antigravity-guard \
           /etc/systemd/journald.conf.d/50-antigravity-guard.conf \
           /etc/sysctl.d/99-antigravity-guard.conf
sudo systemctl daemon-reload
```

swap 需要单独处理：`sudo swapoff /swapfile && sudo rm /swapfile`，并从 `/etc/fstab` 里删掉那一行。
