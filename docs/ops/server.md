# 服务器端要做的事

插件跑在 DSH 这一侧，真正干活的是远端那台运行 `agy acp` 的机器。那台机器的资源问题会以
"插件坏了" 的样子出现，所以装完插件之后，建议在那台机器上再跑一次
[`scripts/server-guard.sh`](../../scripts/server-guard.sh)。

## 为什么需要

一次真实事故，同一台机器上同时出现三件事：

- 上一个 DSH 进程留下的转发还占着远端端口，新的转发绑不上，日志里刷了 1336 次
  `cannot listen to port`。
- 那台机器只有 1.6G 内存，**没有 swap**。
- 从出现内存压力到彻底不再写日志，中间只有六分钟；之后它还能接受 TCP 连接，但不再回 SSH
  banner，`agy` 的工具通道和额度桥一起失联，只能重启。

插件这一侧已经改了：远端端口被占时会换端口、所有端口都失败时会说清是主机的问题、隧道尝试
有总量预算（默认每 10 分钟 20 次），正常退出也会先把会话关掉再拆链路。但**机器本身没有余量**
这件事，插件管不了。

## 脚本装了什么

一个幂等的安装脚本，重复运行只会补齐缺失项，不会重建已有的 swap：

1. **swap 和低 swappiness**：默认 2G，写进 `/etc/fstab`；`vm.swappiness=10`，只在真有压力时
   才回收。没有 swap 的 1.6G 机器，一次突发就是整机卡死；有 swap 最差是变慢。
2. **日志上限**：journald 限制 200M，并给看护日志配了轮转。
3. **5 分钟一次的看护**（`antigravity-guard.timer`）：
   - 记一行内存、swap、iowait、磁盘、worker 数、无主 worker 数；
   - 回收父进程已经不在的 `agy acp` worker（`sshd` 正常会在会话结束时收掉它，父进程变成 1
     说明没被收掉，这些 worker 会一直占内存到下次重启）；
   - 内存可用低于 200M、磁盘占用超过 85%、swap 使用超过 80% 时把该行标成 `status=warn`。

## 怎么装

把仓库里的脚本传到那台机器上执行即可，两台（或多台）机器各跑一次：

```sh
scp scripts/server-guard.sh user@host:/tmp/
ssh user@host 'sudo bash /tmp/server-guard.sh'
```

不想落盘也可以直接管道：

```sh
ssh user@host 'sudo -n bash -s' < scripts/server-guard.sh
```

非 root 的机器上用 `sudo` 执行；脚本自己会检查权限。装完会打印内存、swap、定时器状态和
第一行看护记录。

## 怎么读

```sh
tail -5 /var/log/antigravity-guard.log
```

```
2026-11-15T16:54:59+08:00 status=ok load=0.00 mem_avail=1232M swap=0/2047M iowait=0% disk=16% agy=0 orphan=0 reaped=0
```

- `agy` 是当前 worker 数，`orphan` 是父进程已消失的数量，`reaped` 是这一轮回收掉的数量。
- `status=warn` 后面会跟着原因（`mem<200M`、`disk>=85%`、`swap>=80%`）。
- 出现 `status=warn` 时先看 `reaped` 是否在涨：在涨说明确实有 worker 在堆积。

## 阈值

脚本用环境变量覆盖默认值，不用改代码：

| 变量 | 默认 | 含义 |
|---|---|---|
| `SWAP_SIZE` | `2G` | 新建 swap 的大小 |
| `MEM_WARN_MB` | `200` | 可用内存低于它就算 warn |
| `DISK_WARN_PCT` | `85` | 磁盘占用超过它就算 warn |

重跑脚本会按新阈值重写看护脚本，swap 不会被重建。

## 还要配的地方

- **云监控的内存指标**。这次事故里内存那一栏是"暂无数据"，最该看的指标恰好是空的。装好探针
  后至少配三类告警：磁盘占用、可用内存、实例不可达。指标缺失本身也值得告警一次。
- **SSH 的 keepalive**：`ClientAliveInterval 30`、`ClientAliveCountMax 3`，让掉线的会话尽快
  释放。这不是这次的原因，但能让死会话不长期占着 `sshd` 的子进程名额。

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
