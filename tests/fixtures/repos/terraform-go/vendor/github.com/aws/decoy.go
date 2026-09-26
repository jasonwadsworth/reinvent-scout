// Decoy inside a vendored dependency tree -- a real walker must never descend into vendor.
package decoy

import "github.com/aws/aws-sdk-go-v2/service/kms"

func ShouldNeverBeDetected() {
	_ = kms.Options{}
}
