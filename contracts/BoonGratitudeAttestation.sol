// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * BoonGratitudeAttestation — minimal ERC-721 + ERC-5192 soulbound proof.
 *
 * No OpenZeppelin dependency by design. BoonV2 is initialized once as the minter,
 * then initialization is permanently locked. Transfers and approvals always revert.
 */
contract BoonGratitudeAttestation {
    struct AttestationData {
        address recipient;
        bytes32 handleHash;
        uint256 agentId;
        bytes32 privateCommitment;
        uint256 boonBurned;
        uint256 mintedAt;
    }

    string public constant name = "Boon Gratitude Attestation";
    string public constant symbol = "BOON-SBT";

    address public immutable deployer;
    address public minter;
    bool public minterLocked;

    string public metadataBaseURI; // e.g. "https://api.boonprotocol.com/api/v1/attestations/"
    bool public metadataBaseURILocked;

    mapping(uint256 => AttestationData) public attestations;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 indexed tokenId);
    event MinterInitialized(address indexed minter);
    event AttestationMinted(
        uint256 indexed tipId,
        address indexed recipient,
        bytes32 indexed handleHash,
        uint256 agentId,
        bytes32 privateCommitment,
        uint256 boonBurned
    );

    error NotDeployer();
    error NotMinter();
    error ZeroAddress();
    error MinterLocked();
    error TokenAlreadyMinted();
    error TokenNotMinted();
    error Soulbound();

    constructor() {
        deployer = msg.sender;
    }

    function initializeMinter(address boonV2) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (boonV2 == address(0)) revert ZeroAddress();
        if (minterLocked || minter != address(0)) revert MinterLocked();
        minter = boonV2;
        minterLocked = true;
        emit MinterInitialized(boonV2);
    }

    function initializeMetadataBaseURI(string calldata baseURI) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (metadataBaseURILocked) revert MinterLocked(); // reuse error for simplicity
        if (bytes(baseURI).length == 0) revert ZeroAddress();
        metadataBaseURI = baseURI;
        metadataBaseURILocked = true;
    }

    function mint(
        uint256 tipId,
        address recipient,
        bytes32 handleHashAtMint,
        uint256 agentIdAtMint,
        bytes32 privateCommitment,
        uint256 boonBurnedTotal
    ) external {
        if (msg.sender != minter) revert NotMinter();
        if (recipient == address(0)) revert ZeroAddress();
        if (ownerOf[tipId] != address(0)) revert TokenAlreadyMinted();

        ownerOf[tipId] = recipient;
        unchecked {
            balanceOf[recipient] += 1;
        }
        attestations[tipId] = AttestationData({
            recipient: recipient,
            handleHash: handleHashAtMint,
            agentId: agentIdAtMint,
            privateCommitment: privateCommitment,
            boonBurned: boonBurnedTotal,
            mintedAt: block.timestamp
        });

        emit Transfer(address(0), recipient, tipId);
        emit Locked(tipId);
        emit AttestationMinted(
            tipId, recipient, handleHashAtMint, agentIdAtMint, privateCommitment, boonBurnedTotal
        );
    }

    function locked(uint256 tokenId) external view returns (bool) {
        _requireMinted(tokenId);
        return true;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        _requireMinted(tokenId);

        if (bytes(metadataBaseURI).length > 0) {
            // Preferred path: configurable base URI (e.g. https://api.boonprotocol.com/api/v1/attestations/)
            // The hosted metadata endpoint serves full ERC-721 JSON + image at that path.
            return string.concat(metadataBaseURI, _toString(tokenId));
        }

        // Fallback: minimal safe data URI
        return string.concat(
            "data:application/json,",
            "{\"name\":\"Boon Gratitude Attestation #",
            _toString(tokenId),
            "\",\"description\":\"Soulbound proof of a funded Boon gratitude tip.\",",
            "\"image\":\"https://boonprotocol.com/attestation-og-image.png\",",
            "\"external_url\":\"https://boonprotocol.com\"}"
        );
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 Metadata extension
            || interfaceId == 0xb45a3c0e; // ERC-5192
    }

    function approve(address, uint256) external pure {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) external pure {
        revert Soulbound();
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        _requireMinted(tokenId);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function _requireMinted(uint256 tokenId) internal view {
        if (ownerOf[tokenId] == address(0)) revert TokenNotMinted();
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            unchecked {
                digits++;
                temp /= 10;
            }
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            unchecked {
                digits -= 1;
                buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
                value /= 10;
            }
        }
        return string(buffer);
    }
}
