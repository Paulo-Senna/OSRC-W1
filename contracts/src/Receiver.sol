// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Lives on Para B. Records every message it receives, so a cross-chain call
/// from Para A shows up as an observable state change.
contract Receiver {
    uint256 public messageCount;   // how many messages arrived
    string public lastMessage;     // text of the latest message
    address public lastCaller;     // who called (Para A's sovereign account when it comes via XCM)

    event MessageReceived(address indexed caller, uint256 count, string message);

    function receiveMessage(string calldata message) external {
        messageCount += 1;
        lastMessage = message;
        lastCaller = msg.sender;
        emit MessageReceived(msg.sender, messageCount, message);
    }
}
