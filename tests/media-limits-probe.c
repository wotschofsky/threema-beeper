#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    if (!strcmp(argv[1], "memory")) {
        void *allocation = malloc(67108864);
        if (allocation) { free(allocation); return 2; }
        return 0;
    }
    if (!strcmp(argv[1], "cpu")) { for (;;) {} }
    struct rlimit value;
    int resources[] = {RLIMIT_CORE, RLIMIT_CPU, RLIMIT_AS, RLIMIT_FSIZE, RLIMIT_NOFILE};
    rlim_t expected[] = {0, 1, 33554432, 1024, 64};
    for (int i = 0; i < 5; i++) {
        if (getrlimit(resources[i], &value) || value.rlim_cur != expected[i] || value.rlim_max != expected[i]) return 3;
    }
    if (getenv("SYNTHETIC_SECRET") || !getenv("OMP_NUM_THREADS")) return 4;
    return 0;
}
