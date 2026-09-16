/* Resource boundary for a trusted codec command. No shell or inherited environment.
 * This is not a filesystem/network sandbox; deployment must provide that isolation.
 * Usage: media-limits CPU_SECONDS MEMORY_BYTES OUTPUT_BYTES /absolute/codec [args...]
 */
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>
#endif

static void fail(void) {
    fputs("Media resource setup failed\n", stderr);
    _exit(125);
}
static rlim_t number(const char *text, unsigned long long min, unsigned long long max) {
    if (!text || !*text) fail();
    for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') fail();
    errno = 0;
    char *end;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno || *end || value < min || value > max || (unsigned long long)(rlim_t)value != value) fail();
    return (rlim_t)value;
}
static void limit(int resource, rlim_t value) {
    struct rlimit setting = {value, value};
    if (setrlimit(resource, &setting) != 0) fail();
}
int main(int argc, char **argv) {
    if (argc < 5 || argv[4][0] != '/') fail();
    rlim_t cpu = number(argv[1], 1, 300);
    rlim_t memory = number(argv[2], 16777216, 4294967296ULL);
    rlim_t output = number(argv[3], 1, 1073741824);
    long descriptors = sysconf(_SC_OPEN_MAX);
    if (descriptors < 3 || descriptors > 1048576) fail();
    limit(RLIMIT_CORE, 0);
    limit(RLIMIT_CPU, cpu);
    limit(RLIMIT_FSIZE, output);
    limit(RLIMIT_NOFILE, 64);
#ifndef __APPLE__
    limit(RLIMIT_AS, memory);
#endif
    /* Use the original descriptor limit: lowering NOFILE does not close existing FDs. */
    for (int fd = 3; fd < descriptors; fd++) close(fd);
    char *environment[] = {"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "OMP_NUM_THREADS=1", "OPENBLAS_NUM_THREADS=1", NULL};
#ifdef __APPLE__
    /* Darwin rejects finite address-space limits. Monitor physical footprint instead.
     * This is a sampled kill threshold, not Linux's allocation-time AS ceiling.
     * Keep a private process group so cancellation also kills codec descendants. */
    if (setpgid(0, 0) != 0 && getpgrp() != getpid()) fail();
    pid_t child = fork();
    if (child < 0) fail();
    if (child > 0) {
        close(STDIN_FILENO);
        close(STDOUT_FILENO);
        for (;;) {
            int status;
            pid_t done = waitpid(child, &status, WNOHANG);
            if (done == child) {
                if (WIFEXITED(status)) return WEXITSTATUS(status);
                return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 125;
            }
            if (done < 0 && errno != EINTR) fail();
            struct rusage_info_v2 usage;
            if (proc_pid_rusage(child, RUSAGE_INFO_V2, (rusage_info_t *)&usage) == 0) {
                if (usage.ri_phys_footprint > memory) {
                    kill(-getpgrp(), SIGKILL);
                    fail();
                }
            } else if (errno != ESRCH) {
                kill(-getpgrp(), SIGKILL);
                fail();
            }
            struct timespec pause = {0, 10000000};
            nanosleep(&pause, NULL);
        }
    }
#endif
    execve(argv[4], &argv[4], environment);
    fail();
}
